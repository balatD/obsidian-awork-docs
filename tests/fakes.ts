import type {
	CreateRemoteDoc,
	DocSelection,
	DownloadedFile,
	LocalFile,
	LocalVault,
	RemoteDoc,
	RemoteDocs,
	RemoteSpace,
	RenameRemoteDoc,
	UploadFile,
} from '../src/core/ports';

/** A controllable clock so tests can order remote and local edits precisely. */
export class TestClock {
	constructor(private millis = Date.parse('2026-08-24T10:00:00.000Z')) {}

	now(): Date {
		return new Date(this.millis);
	}

	get value(): number {
		return this.millis;
	}

	advance(millis: number): this {
		this.millis += millis;
		return this;
	}
}

export class FakeRemote implements RemoteDocs {
	readonly docs = new Map<string, RemoteDoc>();
	readonly content = new Map<string, string>();
	readonly spaces: RemoteSpace[] = [];
	readonly trashed: string[] = [];
	/** fileId -> what `downloadFile` should hand back. */
	readonly files = new Map<string, DownloadedFile>();
	readonly downloads: string[] = [];
	readonly uploads: Array<{ documentId: string; fileName: string; bytes: number }> = [];
	private nextId = 1;

	constructor(private readonly clock: TestClock) {}

	addSpace(id: string, name: string): RemoteSpace {
		const space = { id, name };
		this.spaces.push(space);
		return space;
	}

	/** Seeds a document without going through the API surface. */
	seed(doc: Partial<RemoteDoc> & { id: string; name: string }, markdown: string): RemoteDoc {
		const full: RemoteDoc = {
			scope: 'space',
			spaceId: null,
			parentId: null,
			emoji: null,
			updatedOn: this.clock.now().toISOString(),
			...doc,
		};
		this.docs.set(full.id, full);
		this.content.set(full.id, markdown);
		return full;
	}

	/** Simulates somebody editing the document inside awork. */
	editRemotely(id: string, markdown: string): RemoteDoc {
		const doc = this.require(id);
		const updated = { ...doc, updatedOn: this.clock.now().toISOString() };
		this.docs.set(id, updated);
		this.content.set(id, markdown);
		return updated;
	}

	async listSpaces(): Promise<RemoteSpace[]> {
		return [...this.spaces];
	}

	async listDocuments(selection: DocSelection): Promise<RemoteDoc[]> {
		return [...this.docs.values()].filter((doc) => {
			if (doc.scope === 'private') return selection.includePrivate;
			if (doc.scope === 'shared') return selection.includeShared;
			return doc.spaceId !== null && selection.spaceIds.includes(doc.spaceId);
		});
	}

	async getMarkdown(id: string): Promise<string> {
		this.require(id);
		return this.content.get(id) ?? '';
	}

	async putMarkdown(id: string, markdown: string): Promise<RemoteDoc> {
		const doc = this.require(id);
		this.content.set(id, markdown);
		const updated = { ...doc, updatedOn: this.clock.now().toISOString() };
		this.docs.set(id, updated);
		return updated;
	}

	async create(input: CreateRemoteDoc): Promise<RemoteDoc> {
		const doc: RemoteDoc = {
			id: `doc-${this.nextId++}`,
			name: input.name,
			scope: input.scope,
			spaceId: input.spaceId,
			parentId: input.parentId,
			emoji: null,
			updatedOn: this.clock.now().toISOString(),
		};
		this.docs.set(doc.id, doc);
		this.content.set(doc.id, input.markdown);
		return doc;
	}

	async update(id: string, patch: RenameRemoteDoc): Promise<RemoteDoc> {
		const doc = this.require(id);
		const updated: RemoteDoc = {
			...doc,
			...(patch.name !== undefined ? { name: patch.name } : {}),
			...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
			...(patch.spaceId !== undefined ? { spaceId: patch.spaceId } : {}),
			updatedOn: this.clock.now().toISOString(),
		};
		this.docs.set(id, updated);
		return updated;
	}

	async trash(id: string): Promise<void> {
		this.require(id);
		this.docs.delete(id);
		this.trashed.push(id);
	}

	async uploadFile(documentId: string, file: UploadFile): Promise<string> {
		const fileId = `file-${this.nextId++}`;
		this.uploads.push({ documentId, fileName: file.fileName, bytes: file.bytes.byteLength });
		this.files.set(fileId, {
			bytes: file.bytes,
			contentType: file.mimeType,
			contentDisposition: `attachment; filename="${file.fileName}"`,
		});
		return fileId;
	}

	async downloadFile(fileId: string): Promise<DownloadedFile> {
		const file = this.files.get(fileId);
		if (!file) throw new Error(`No such file: ${fileId}`);
		this.downloads.push(fileId);
		return file;
	}

	private require(id: string): RemoteDoc {
		const doc = this.docs.get(id);
		if (!doc) throw new Error(`No such document: ${id}`);
		return doc;
	}
}

export class InMemoryVault implements LocalVault {
	readonly files = new Map<string, { content: string; mtime: number }>();
	readonly binary = new Map<string, ArrayBuffer>();
	readonly trashed: string[] = [];

	constructor(private readonly clock: TestClock) {}

	/** Simulates the user editing a note; bumps mtime like a real write would. */
	edit(path: string, content: string): void {
		this.files.set(path, { content, mtime: this.clock.value });
	}

	async list(root: string): Promise<LocalFile[]> {
		return [...this.files.entries()]
			.filter(([path]) => path === root || path.startsWith(`${root}/`))
			.filter(([path]) => !path.startsWith(`${root}/_conflicts`))
			.filter(([path]) => !this.binary.has(path))
			.map(([path, file]) => ({ path, mtime: file.mtime }));
	}

	async read(path: string): Promise<string> {
		const file = this.files.get(path);
		if (!file) throw new Error(`No such note: ${path}`);
		return file.content;
	}

	async readCached(path: string): Promise<string> {
		return this.read(path);
	}

	async write(path: string, content: string, expected?: string): Promise<boolean> {
		const current = this.files.get(path);
		if (expected !== undefined && current !== undefined && current.content !== expected) return false;
		this.files.set(path, { content, mtime: this.clock.value });
		return true;
	}

	async writeBinary(path: string, bytes: ArrayBuffer): Promise<void> {
		this.binary.set(path, bytes);
		this.files.set(path, { content: `<${bytes.byteLength} bytes>`, mtime: this.clock.value });
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const bytes = this.binary.get(path);
		if (!bytes) throw new Error(`No such attachment: ${path}`);
		return bytes;
	}

	/** Resolves by filename anywhere in the vault, like Obsidian's shortest path. */
	async resolveEmbed(name: string): Promise<string | null> {
		for (const path of this.binary.keys()) {
			if (path.slice(path.lastIndexOf('/') + 1) === name) return path;
		}
		return null;
	}

	async rename(from: string, to: string): Promise<void> {
		const file = this.files.get(from);
		if (!file) throw new Error(`No such note: ${from}`);
		this.files.delete(from);
		this.files.set(to, file);
	}

	async trash(path: string): Promise<void> {
		this.files.delete(path);
		this.trashed.push(path);
	}

	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}
}
