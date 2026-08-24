/**
 * Markdown fidelity probe.
 *
 * awork stores documents in its own editor model and converts to and from
 * markdown on the way out and in. This script measures what that conversion
 * costs: it reads a document as markdown, writes the same markdown straight
 * back, reads it again and diffs. Anything that shows up here is a construct
 * the plugin cannot round-trip losslessly.
 *
 *   npm run -s roundtrip -- --list
 *   npm run -s roundtrip -- <documentId>          # read-only comparison
 *   npm run -s roundtrip -- <documentId> --write  # actually writes it back
 */
import { AworkClient } from '../src/api/awork-client';
import { FetchTransport } from '../src/api/fetch-transport';
import { ThrottledTransport } from '../src/api/http';
import { CliTokens } from './token-file';

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const client = new AworkClient(new ThrottledTransport(new FetchTransport()), new CliTokens());

	if (args.includes('--list') || args.length === 0) {
		await list(client);
		return;
	}

	const documentId = args[0] as string;
	const write = args.includes('--write');

	const before = await client.getMarkdown(documentId);
	console.log(`--- markdown from awork (${before.length} chars) ---`);
	console.log(before);

	if (!write) {
		console.log('\nRead-only. Re-run with --write to push it back and compare.');
		return;
	}

	console.log('\nWriting the same markdown back…');
	await client.putMarkdown(documentId, before);
	const after = await client.getMarkdown(documentId);

	if (after === before) {
		console.log('Round-trip is byte-identical.');
		return;
	}

	console.log(`Round-trip changed the document (${before.length} → ${after.length} chars):\n`);
	printDiff(before, after);
}

async function list(client: AworkClient): Promise<void> {
	const spaces = await client.listSpaces();
	const docs = await client.listDocuments({
		spaceIds: spaces.map((space) => space.id),
		includePrivate: true,
		includeShared: true,
	});

	const spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
	console.log(`${docs.length} documents in scope:\n`);
	for (const doc of docs) {
		const where = doc.scope === 'space' ? (spaceNames.get(doc.spaceId ?? '') ?? 'space') : doc.scope;
		console.log(`  ${doc.id}  [${where}]  ${doc.name}`);
	}
}

/** Line-level diff; enough to spot what the editor rewrote. */
function printDiff(before: string, after: string): void {
	const a = before.split('\n');
	const b = after.split('\n');
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] === b[i]) continue;
		if (a[i] !== undefined) console.log(`  - ${a[i]}`);
		if (b[i] !== undefined) console.log(`  + ${b[i]}`);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
