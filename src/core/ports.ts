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
	/** Fetches an embedded file. The endpoint requires the bearer token. */
	downloadFile(fileId: string): Promise<DownloadedFile>;
	/** Attaches a file to a document and returns the new file's id. */
	uploadFile(documentId: string, file: UploadFile): Promise<string>;
}

export interface UploadFile {
	fileName: string;
	mimeType: string;
	bytes: ArrayBuffer;
}

export interface DownloadedFile {
	bytes: ArrayBuffer;
	contentType: string | undefined;
	contentDisposition: string | undefined;
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
	/**
	 * Replaces the note's content.
	 *
	 * When `expected` is given, the write only happens if the file still holds
	 * exactly that — otherwise it was edited since the sync read it, and
	 * `false` is returned so the caller can treat it as a conflict rather than
	 * silently discarding those edits.
	 */
	write(path: string, content: string, expected?: string): Promise<boolean>;
	writeBinary(path: string, bytes: ArrayBuffer): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer>;
	/**
	 * Resolves an Obsidian embed target (`![[name]]`) to a vault path, the same
	 * way Obsidian itself would from the note doing the embedding.
	 */
	resolveEmbed(name: string, fromNotePath: string): Promise<string | null>;
	/** Moves to the system/Obsidian trash rather than unlinking. */
	trash(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}
