import type { DocScope, RemoteDoc, RemoteSpace } from './ports';

/**
 * Turns awork's (space, parent chain, name) into vault paths.
 *
 * Identity is always the awork document id — never the path — so a rename on
 * either side is a move rather than a delete plus a create. A document that has
 * children becomes both `Parent.md` and a sibling `Parent/` folder, which is
 * the conventional Obsidian folder-note layout.
 */

/**
 * Where a document that has children keeps its own note.
 *
 * `inside` puts it in the folder it owns (`Kunden/Kunden.md`) — the convention
 * the Folder Notes community plugin uses, and the only one that keeps a parent
 * next to its children, since Obsidian sorts every folder above every file.
 * `sibling` puts it alongside (`Kunden.md` next to `Kunden/`).
 */
export type NestingStyle = 'inside' | 'sibling';

export interface MappingOptions {
	syncRoot: string;
	privateFolder: string;
	sharedFolder: string;
	nesting: NestingStyle;
}

export const defaultMappingOptions: MappingOptions = {
	syncRoot: 'awork',
	privateFolder: 'Private',
	sharedFolder: 'Shared with me',
	nesting: 'inside',
};

const ILLEGAL_CHARACTERS = /[\\/:*?"<>|#^[\]]/g;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;
const MAX_SEGMENT_LENGTH = 120;

export function sanitizeSegment(name: string): string {
	const cleaned = name
		.replace(ILLEGAL_CHARACTERS, '-')
		.replace(CONTROL_CHARACTERS, '')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
		.replace(/[. ]+$/, '');
	const truncated = cleaned.slice(0, MAX_SEGMENT_LENGTH).trim();
	return truncated === '' ? 'Untitled' : truncated;
}

export function scopeFolder(
	scope: DocScope,
	spaceName: string | null,
	options: MappingOptions,
): string {
	switch (scope) {
		case 'private':
			return `${options.syncRoot}/${options.privateFolder}`;
		case 'shared':
			return `${options.syncRoot}/${options.sharedFolder}`;
		case 'space':
			return `${options.syncRoot}/${sanitizeSegment(spaceName ?? 'Space')}`;
	}
}

/**
 * Computes the target path for every in-scope document in one pass, because
 * paths depend on ancestors and on collisions with siblings.
 */
export function buildPathMap(
	docs: RemoteDoc[],
	spaces: RemoteSpace[],
	options: MappingOptions = defaultMappingOptions,
): Map<string, string> {
	const spaceNames = new Map(spaces.map((space) => [space.id, space.name]));
	const byId = new Map(docs.map((doc) => [doc.id, doc]));

	const folderOf = (doc: RemoteDoc): string => {
		const chain: string[] = [];
		const seen = new Set<string>([doc.id]);
		let parentId = doc.parentId;
		while (parentId !== null) {
			const parent = byId.get(parentId);
			// Parent outside the synced scope (or a cycle): anchor at scope root.
			if (!parent || seen.has(parent.id)) break;
			seen.add(parent.id);
			chain.unshift(sanitizeSegment(parent.name));
			parentId = parent.parentId;
		}
		const spaceName = doc.spaceId ? (spaceNames.get(doc.spaceId) ?? null) : null;
		const base = scopeFolder(doc.scope, spaceName, options);
		return chain.length === 0 ? base : `${base}/${chain.join('/')}`;
	};

	const hasChildren = new Set(docs.map((doc) => doc.parentId).filter((id): id is string => id !== null));

	// Shallowest first so a parent claims its own name before any child can, then
	// by id so collision suffixes stay stable between runs.
	const ordered = [...docs].sort(
		(a, b) => depthOf(a, byId) - depthOf(b, byId) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	const taken = new Set<string>();
	const paths = new Map<string, string>();

	for (const doc of ordered) {
		const folder = folderOf(doc);
		const stem = sanitizeSegment(doc.name);
		// A document with children owns a folder; where its own note goes inside
		// that folder is the caller's choice.
		const home = options.nesting === 'inside' && hasChildren.has(doc.id) ? `${folder}/${stem}` : folder;

		let candidate = `${home}/${stem}.md`;
		for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix++) {
			candidate = `${home}/${stem} (${suffix}).md`;
		}
		taken.add(candidate.toLowerCase());
		paths.set(doc.id, candidate);
	}
	return paths;
}

function depthOf(doc: RemoteDoc, byId: Map<string, RemoteDoc>): number {
	let depth = 0;
	const seen = new Set<string>([doc.id]);
	let parentId = doc.parentId;
	while (parentId !== null && !seen.has(parentId)) {
		const parent = byId.get(parentId);
		if (!parent) break;
		seen.add(parent.id);
		depth++;
		parentId = parent.parentId;
	}
	return depth;
}

/** `awork/Space/Parent/Child.md` → `Child`. */
export function nameFromPath(path: string): string {
	const file = path.slice(path.lastIndexOf('/') + 1);
	return file.endsWith('.md') ? file.slice(0, -3) : file;
}

export function parentFolder(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
}

export function isUnder(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

/**
 * Conflict copies live here. Deliberately not a dot-folder: Obsidian's vault
 * API does not index those, so the plugin could write copies the user would
 * never see. It is excluded from the scan by `isExcluded` instead.
 */
export function conflictFolder(options: MappingOptions): string {
	return `${options.syncRoot}/_conflicts`;
}

/** Paths the sync must never treat as syncable notes. */
export function isExcluded(path: string, options: MappingOptions): boolean {
	return isUnder(path, conflictFolder(options));
}

export function conflictPath(
	originalPath: string,
	side: 'local' | 'awork',
	timestamp: string,
	options: MappingOptions,
): string {
	const stem = sanitizeSegment(nameFromPath(originalPath));
	const stamp = timestamp.replace(/[:.]/g, '-');
	return `${conflictFolder(options)}/${stem} (${side} ${stamp}).md`;
}
