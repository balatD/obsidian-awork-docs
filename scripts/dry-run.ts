/**
 * Runs a full sync pass against the live workspace with an in-memory vault, so
 * nothing is written anywhere. Isolates "is the engine wrong?" from "is the
 * Obsidian side wrong?" when a sync misbehaves in the app.
 *
 *   npm run -s dry-run
 *
 * Reads credentials the same way as the other scripts (connect.ts or
 * AWORK_TOKEN). Only pull actions can result: the fake vault starts empty, so
 * nothing is ever pushed to awork.
 */
import { AworkClient } from '../src/api/awork-client';
import { FetchTransport } from '../src/api/fetch-transport';
import { ThrottledTransport } from '../src/api/http';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/api/http';
import { defaultMappingOptions } from '../src/core/mapping';
import { emptyState } from '../src/core/state';
import { runSync } from '../src/sync-service';
import type { LocalFile, LocalVault } from '../src/core/ports';
import { CliTokens } from './token-file';

/** Accepts every write and remembers it; never touches disk. */
class MemVault implements LocalVault {
	files = new Map<string, string>();
	async list(): Promise<LocalFile[]> { return []; }
	async read(p: string) { return this.files.get(p) ?? ''; }
	async readCached(p: string) { return this.read(p); }
	async write(p: string, c: string) { this.files.set(p, c); }
	async writeBinary(p: string, b: ArrayBuffer) { this.files.set(p, `<${b.byteLength} bytes>`); }
	async rename(a: string, b: string) { this.files.set(b, this.files.get(a) ?? ''); this.files.delete(a); }
	async trash(p: string) { this.files.delete(p); }
	async exists(p: string) { return this.files.has(p); }
}

/** Counts what the API actually answered, so throttling can be judged not guessed. */
class CountingTransport implements HttpTransport {
	readonly statuses = new Map<number, number>();
	constructor(private readonly inner: HttpTransport) {}
	async send(request: HttpRequest): Promise<HttpResponse> {
		const response = await this.inner.send(request);
		this.statuses.set(response.status, (this.statuses.get(response.status) ?? 0) + 1);
		return response;
	}
}

const concurrency = Number(process.env.SYNC_CONCURRENCY ?? 4);
const counter = new CountingTransport(new FetchTransport());
const client = new AworkClient(
	ThrottledTransport.withConcurrency(counter, concurrency),
	new CliTokens(),
);

const vault = new MemVault();
let state = emptyState();

const report = await runSync({
	remote: client,
	vault,
	mapping: defaultMappingOptions,
	selection: { spaceIds: [], includePrivate: true, includeShared: true },
	deletionPolicy: 'ignore',
	frontmatter: 'minimal',
	tables: 'header',
	attachmentFolder: process.env.SYNC_ATTACHMENTS ?? '',
	concurrency,
	loadState: () => state,
	saveState: async (s) => { state = s; },
});

console.log('attachments downloaded:', report.attachments);
console.log('HTTP responses:', Object.fromEntries([...counter.statuses].sort()));
console.log('REPORT:', JSON.stringify(report, null, 2));
console.log(`\n${vault.files.size} notes would be written:`);
for (const path of [...vault.files.keys()].sort()) console.log('  ', path);
