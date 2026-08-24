import { buildPathMap, isUnder, nameFromPath, sanitizeSegment, type MappingOptions } from './mapping';
import type { DocScope, RemoteDoc, RemoteSpace } from './ports';
import type { SyncState } from './state';

/**
 * The pure half of the sync: given what awork has, what the vault has, and what
 * the last sync recorded, decide what to do. No I/O happens here, which is what
 * makes every branch below cheap to test.
 */

/** What to do when a tracked note disappears from the vault. */
export type DeletionPolicy = 'ignore' | 'mirror';

export interface LocalNote {
	path: string;
	mtime: number;
	/** From frontmatter; null for a note the plugin has never seen. */
	aworkId: string | null;
	bodyHash: string;
}

export interface PlanInput {
	remote: RemoteDoc[];
	spaces: RemoteSpace[];
	local: LocalNote[];
	state: SyncState;
	mapping: MappingOptions;
	deletionPolicy: DeletionPolicy;
}

export type SyncAction =
	/** awork has a document the vault does not. */
	| { kind: 'pull-create'; doc: RemoteDoc; path: string }
	/** Remote content changed; overwrite the note body in place. */
	| { kind: 'pull-update'; doc: RemoteDoc; path: string }
	/** Renamed or reparented in awork; move the note to match. */
	| { kind: 'move-local'; doc: RemoteDoc; from: string; to: string }
	/** An untracked note below the sync root becomes a new awork document. */
	| { kind: 'push-create'; path: string; name: string; scope: DocScope; spaceId: string | null; parentId: string | null }
	/** Local body changed; PUT it to awork. */
	| { kind: 'push-update'; doc: RemoteDoc; path: string }
	/** Note renamed or moved in the vault; mirror onto the awork document. */
	| { kind: 'push-rename'; doc: RemoteDoc; path: string; name: string; spaceId: string | null; parentId: string | null }
	/** Both sides changed. `winner` decides who survives; the loser is archived. */
	| { kind: 'conflict'; doc: RemoteDoc; path: string; winner: 'local' | 'remote' }
	/** Gone from awork (deleted or trashed); move the note to the vault trash. */
	| { kind: 'local-trash'; id: string; path: string }
	/** Note deleted locally and the policy says to mirror that to awork. */
	| { kind: 'remote-trash'; id: string; name: string }
	/** Nothing to transfer, but the record needs refreshing (e.g. new timestamp). */
	| { kind: 'touch'; doc: RemoteDoc; path: string };

export interface SyncPlan {
	actions: SyncAction[];
	/** Documents that need no work at all — reported, never executed. */
	unchanged: number;
}

export function buildPlan(input: PlanInput): SyncPlan {
	const { remote, spaces, local, state, mapping, deletionPolicy } = input;

	const desiredPaths = buildPathMap(remote, spaces, mapping);
	const remoteById = new Map(remote.map((doc) => [doc.id, doc]));
	const localById = new Map<string, LocalNote>();
	const untracked: LocalNote[] = [];

	// Notes need not carry an id in frontmatter — with the "none" property style
	// they never do — so fall back to the path the last sync recorded. This also
	// rescues notes whose frontmatter a user stripped by hand.
	const idByPath = new Map<string, string>();
	for (const record of Object.values(state.docs)) idByPath.set(record.path, record.id);

	for (const note of local) {
		const id = note.aworkId ?? idByPath.get(note.path) ?? null;
		if (id === null) untracked.push(note);
		// A duplicated note carries a duplicated id; the first one wins and the
		// copy is treated as untracked so it becomes its own document.
		else if (localById.has(id)) untracked.push({ ...note, aworkId: null });
		else localById.set(id, { ...note, aworkId: id });
	}

	const locator = new LocationResolver(desiredPaths, spaces, mapping);
	const actions: SyncAction[] = [];
	let unchanged = 0;

	for (const doc of remote) {
		const record = state.docs[doc.id];
		const note = localById.get(doc.id);
		const desiredPath = desiredPaths.get(doc.id) as string;

		if (!note) {
			if (!record) {
				actions.push({ kind: 'pull-create', doc, path: desiredPath });
			} else if (deletionPolicy === 'mirror') {
				actions.push({ kind: 'remote-trash', id: doc.id, name: doc.name });
			} else {
				// The note vanished but we are not mirroring deletions, so awork
				// stays the source of truth and the note comes back.
				actions.push({ kind: 'pull-create', doc, path: desiredPath });
			}
			continue;
		}

		if (!record) {
			// State was lost but the note still carries the id: adopt it rather
			// than duplicating, and let newest-wins settle the content.
			actions.push(adopt(doc, note, desiredPath));
			continue;
		}

		const remoteChanged = isNewer(doc.updatedOn, record.remoteUpdatedOn);
		const localChanged = note.bodyHash !== record.bodyHash;
		const remoteMoved = desiredPath !== record.path;
		const localMoved = note.path !== record.path;

		if (remoteChanged && localChanged) {
			const winner = remoteWins(doc.updatedOn, note.mtime) ? 'remote' : 'local';
			actions.push({ kind: 'conflict', doc, path: winner === 'remote' ? desiredPath : note.path, winner });
			if (winner === 'remote' && localMoved) {
				actions.push({ kind: 'move-local', doc, from: note.path, to: desiredPath });
			}
			continue;
		}

		if (remoteChanged) {
			if (remoteMoved) actions.push({ kind: 'move-local', doc, from: note.path, to: desiredPath });
			actions.push({ kind: 'pull-update', doc, path: desiredPath });
			continue;
		}

		if (localChanged) {
			actions.push({ kind: 'push-update', doc, path: note.path });
			if (localMoved) actions.push(renameFrom(doc, note, locator));
			continue;
		}

		// Content is settled; only the location may still disagree.
		if (localMoved) actions.push(renameFrom(doc, note, locator));
		else if (remoteMoved) actions.push({ kind: 'move-local', doc, from: note.path, to: desiredPath });
		else unchanged++;
	}

	// Tracked notes whose document is no longer in scope: deleted, trashed, or
	// unshared. Either way it should not linger in the vault.
	for (const [id, note] of localById) {
		if (remoteById.has(id)) continue;
		if (state.docs[id]) actions.push({ kind: 'local-trash', id, path: note.path });
		// No record either: the note claims an id we cannot see. Leave it alone
		// rather than trashing something the user may still want.
	}

	for (const note of untracked) {
		if (!isUnder(note.path, mapping.syncRoot)) continue;
		const location = locator.locate(note.path);
		// "Shared with me" is a read-only view onto other people's documents —
		// there is no sensible owner for a new document dropped in there.
		if (location === null || location.scope === 'shared') continue;
		actions.push({
			kind: 'push-create',
			path: note.path,
			name: nameFromPath(note.path),
			scope: location.scope,
			spaceId: location.spaceId,
			parentId: location.parentId,
		});
	}

	return { actions, unchanged };
}

function adopt(doc: RemoteDoc, note: LocalNote, desiredPath: string): SyncAction {
	// Without a record we cannot tell which side moved on, so fall back to the
	// same newest-wins rule used for real conflicts.
	return remoteWins(doc.updatedOn, note.mtime)
		? { kind: 'pull-update', doc, path: note.path === desiredPath ? desiredPath : note.path }
		: { kind: 'push-update', doc, path: note.path };
}

function renameFrom(doc: RemoteDoc, note: LocalNote, locator: LocationResolver): SyncAction {
	const location = locator.locate(note.path);
	return {
		kind: 'push-rename',
		doc,
		path: note.path,
		name: nameFromPath(note.path),
		spaceId: location?.spaceId ?? doc.spaceId,
		parentId: location?.parentId ?? null,
	};
}

/** awork timestamps are ISO strings; compare as instants, not lexically. */
function isNewer(candidate: string, baseline: string): boolean {
	const a = Date.parse(candidate);
	const b = Date.parse(baseline);
	if (Number.isNaN(a) || Number.isNaN(b)) return candidate !== baseline;
	return a > b;
}

/**
 * Ties go to the remote copy: awork's `updatedOn` and the local mtime come from
 * different clocks, and re-downloading is the recoverable direction (the local
 * version is archived either way).
 */
function remoteWins(updatedOn: string, mtime: number): boolean {
	const remoteTime = Date.parse(updatedOn);
	if (Number.isNaN(remoteTime)) return false;
	return remoteTime >= mtime;
}

export interface DocLocation {
	scope: DocScope;
	spaceId: string | null;
	parentId: string | null;
}

/**
 * Reverse of the path mapping: works out which space and parent document a
 * vault path implies, so local creates and moves land in the right place in
 * awork. A folder belongs to a document when a sibling note of the same name
 * exists (`Parent/` ↔ `Parent.md`) — the folder-note convention.
 */
export class LocationResolver {
	private readonly docIdByPath = new Map<string, string>();
	private readonly spaceIdByFolder = new Map<string, string>();

	constructor(
		desiredPaths: Map<string, string>,
		spaces: RemoteSpace[],
		private readonly mapping: MappingOptions,
	) {
		for (const [id, path] of desiredPaths) this.docIdByPath.set(path.toLowerCase(), id);
		for (const space of spaces) {
			this.spaceIdByFolder.set(sanitizeSegment(space.name).toLowerCase(), space.id);
		}
	}

	locate(path: string): DocLocation | null {
		if (!isUnder(path, this.mapping.syncRoot)) return null;
		const relative = path.slice(this.mapping.syncRoot.length + 1);
		const segments = relative.split('/');
		const top = segments[0];
		if (top === undefined || segments.length < 2) return null;

		const scope = this.scopeOf(top);
		if (scope === null) return null;

		const folder = path.slice(0, path.lastIndexOf('/'));
		const parentId = this.docIdByPath.get(`${folder}.md`.toLowerCase()) ?? null;
		const spaceId = scope === 'space' ? (this.spaceIdByFolder.get(top.toLowerCase()) ?? null) : null;
		if (scope === 'space' && spaceId === null) return null;

		return { scope, spaceId, parentId };
	}

	private scopeOf(topFolder: string): DocScope | null {
		if (topFolder === this.mapping.privateFolder) return 'private';
		if (topFolder === this.mapping.sharedFolder) return 'shared';
		return this.spaceIdByFolder.has(topFolder.toLowerCase()) ? 'space' : null;
	}
}
