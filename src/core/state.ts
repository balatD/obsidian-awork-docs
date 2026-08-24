import type { DocScope } from './ports';

/**
 * What the last successful sync left behind, per document. Kept in the plugin's
 * `data.json`; the note's frontmatter carries the id separately so a lost or
 * corrupted state file degrades to "adopt existing notes" rather than
 * "duplicate everything".
 */
export interface DocRecord {
	id: string;
	path: string;
	name: string;
	scope: DocScope;
	spaceId: string | null;
	parentId: string | null;
	/** awork's `updatedOn` as of the last sync — the remote change detector. */
	remoteUpdatedOn: string;
	/** SHA-256 of the frontmatter-stripped body — the local change detector. */
	bodyHash: string;
	lastSyncedAt: string;
}

/**
 * What the last scan saw for one note. Purely a cache: a mismatch only ever
 * causes extra work (a re-read), never a wrong decision, so a stale or missing
 * entry is always safe.
 */
export interface ScanEntry {
	mtime: number;
	bodyHash: string;
	aworkId: string | null;
}

export interface SyncState {
	version: 1;
	docs: Record<string, DocRecord>;
	/** Keyed by vault path. */
	scan: Record<string, ScanEntry>;
	lastSyncAt: string | null;
}

export function emptyState(): SyncState {
	return { version: 1, docs: {}, scan: {}, lastSyncAt: null };
}

export function migrateState(raw: unknown): SyncState {
	if (!raw || typeof raw !== 'object') return emptyState();
	const candidate = raw as Partial<SyncState>;
	if (candidate.version !== 1 || typeof candidate.docs !== 'object' || candidate.docs === null) {
		return emptyState();
	}
	return {
		version: 1,
		docs: candidate.docs,
		scan: typeof candidate.scan === 'object' && candidate.scan !== null ? candidate.scan : {},
		lastSyncAt: typeof candidate.lastSyncAt === 'string' ? candidate.lastSyncAt : null,
	};
}
