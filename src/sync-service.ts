import { hashBody, readFrontmatterKey, splitFrontmatter } from './core/markdown';
import type { MappingOptions } from './core/mapping';
import { buildPlan, type DeletionPolicy, type LocalNote } from './core/plan';
import type { DocSelection, LocalVault, RemoteDocs } from './core/ports';
import {
	applyPlan,
	FRONTMATTER_ID_KEY,
	type FrontmatterMode,
	type SyncReport,
} from './core/sync-engine';
import type { ScanEntry, SyncState } from './core/state';
import type { TableConversion } from './core/tables';

/**
 * One sync pass, start to finish: scan the vault, ask awork what it has, diff,
 * apply. Kept out of `main.ts` so it can be driven from a test or a script with
 * nothing but the two ports.
 */

export interface SyncDeps {
	remote: RemoteDocs;
	vault: LocalVault;
	mapping: MappingOptions;
	selection: DocSelection;
	deletionPolicy: DeletionPolicy;
	frontmatter: FrontmatterMode;
	tables: TableConversion;
	attachmentFolder: string;
	/** Documents worked on at once. Defaults to the engine's own limit. */
	concurrency?: number;
	loadState: () => SyncState;
	saveState: (state: SyncState) => Promise<void>;
	now?: () => Date;
	onProgress?: (done: number, total: number) => void;
}

export async function runSync(deps: SyncDeps): Promise<SyncReport> {
	const now = deps.now ?? (() => new Date());
	const state = deps.loadState();

	// The vault scan and the remote listing are independent; overlap them.
	const [scan, spaces, remote] = await Promise.all([
		scanVault(deps.vault, deps.mapping, state.scan),
		deps.remote.listSpaces(),
		deps.remote.listDocuments(deps.selection),
	]);
	const local = scan.notes;

	const plan = buildPlan({
		remote,
		// Only the spaces the user opted into may claim a folder.
		spaces: spaces.filter((space) => deps.selection.spaceIds.includes(space.id)),
		local,
		state,
		mapping: deps.mapping,
		deletionPolicy: deps.deletionPolicy,
	});

	const { state: nextState, report } = await applyPlan(plan, {
		remote: deps.remote,
		vault: deps.vault,
		state,
		mapping: deps.mapping,
		frontmatter: deps.frontmatter,
		tables: deps.tables,
		attachmentFolder: deps.attachmentFolder,
		concurrency: deps.concurrency,
		now,
		onProgress: deps.onProgress,
	});

	// Notes rewritten during apply now have newer mtimes than the cache records,
	// so they are simply re-read next pass — correct, and only for what changed.
	await deps.saveState({ ...nextState, scan: scan.cache });
	return report;
}

export interface VaultScan {
	notes: LocalNote[];
	cache: Record<string, ScanEntry>;
}

/**
 * Reads the notes under the sync root, capturing the tracking id from
 * frontmatter and the hash of the body beneath it.
 *
 * Notes whose mtime matches the previous scan are taken from the cache instead
 * of being re-read and re-hashed. On a vault of any size the steady-state pass
 * is then dominated by the handful of files that actually moved.
 */
export async function scanVault(
	vault: LocalVault,
	mapping: MappingOptions,
	previous: Record<string, ScanEntry> = {},
): Promise<VaultScan> {
	const files = await vault.list(mapping.syncRoot);
	const cache: Record<string, ScanEntry> = {};

	const notes = await Promise.all(
		files.map(async (file): Promise<LocalNote> => {
			const cached = previous[file.path];
			if (cached && cached.mtime === file.mtime) {
				cache[file.path] = cached;
				return { path: file.path, mtime: file.mtime, aworkId: cached.aworkId, bodyHash: cached.bodyHash };
			}

			const raw = await vault.readCached(file.path);
			const { frontmatter, body } = splitFrontmatter(raw);
			const entry: ScanEntry = {
				mtime: file.mtime,
				bodyHash: await hashBody(body),
				aworkId: readFrontmatterKey(frontmatter, FRONTMATTER_ID_KEY),
			};
			cache[file.path] = entry;
			return { path: file.path, mtime: file.mtime, aworkId: entry.aworkId, bodyHash: entry.bodyHash };
		}),
	);

	return { notes, cache };
}

export function describeReport(report: SyncReport): string {
	const parts: string[] = [];
	if (report.pulled) parts.push(`${report.pulled} pulled`);
	if (report.pushed) parts.push(`${report.pushed} pushed`);
	if (report.moved) parts.push(`${report.moved} moved`);
	if (report.trashed) parts.push(`${report.trashed} trashed`);
	if (report.conflicts) parts.push(`${report.conflicts} conflicts`);
	if (report.attachments) parts.push(`${report.attachments} images in`);
	if (report.uploads) parts.push(`${report.uploads} images out`);
	if (report.errors.length) parts.push(`${report.errors.length} failed`);
	if (parts.length === 0) return `Up to date (${report.unchanged} documents)`;
	return parts.join(', ');
}
