/**
 * The two seams the sync engine talks through. Both are implemented twice:
 * once for real (awork API / Obsidian vault) and once in-memory for the tests.
 */

/** Where a document lives in awork. Project docs are out of scope for now. */
export type DocScope = 'space' | 'private' | 'shared';

export interface RemoteDoc {
	id: string;
	name: string;
	scope: DocScope;
	spaceId: string | null;
	parentId: string | null;
	updatedOn: string;
	emoji: string | null;
}

export interface RemoteSpace {
	id: string;
	name: string;
}

export interface CreateRemoteDoc {
	name: string;
	markdown: string;
	scope: DocScope;
	spaceId: string | null;
	parentId: string | null;
}

export interface RenameRemoteDoc {
	name?: string;
	spaceId?: string | null;
	parentId?: string | null;
}

/** Which slices of awork the user opted into syncing. */
export interface DocSelection {
	spaceIds: string[];
	includePrivate: boolean;
	includeShared: boolean;
}

export interface RemoteDocs {
	listSpaces(): Promise<RemoteSpace[]>;
	listDocuments(selection: DocSelection): Promise<RemoteDoc[]>;
	getMarkdown(id: string): Promise<string>;
	putMarkdown(id: string, markdown: string): Promise<RemoteDoc>;
	create(input: CreateRemoteDoc): Promise<RemoteDoc>;
	update(id: string, patch: RenameRemoteDoc): Promise<RemoteDoc>;
	/** awork soft-deletes: the document lands in the workspace trash. */
	trash(id: string): Promise<void>;
}

export interface LocalFile {
	path: string;
	/** Epoch millis; only consulted to decide who wins a two-sided conflict. */
	mtime: number;
}

export interface LocalVault {
	/** Markdown files below `root`, recursively. */
	list(root: string): Promise<LocalFile[]>;
	read(path: string): Promise<string>;
	/** Same content as `read`, but allowed to come from a cache. Used by the scan. */
	readCached(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** Moves to the system/Obsidian trash rather than unlinking. */
	trash(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}
