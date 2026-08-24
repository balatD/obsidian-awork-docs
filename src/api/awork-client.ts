import {
	AWORK_API_BASE,
	type DocumentContentModel,
	type DocumentModel,
	type DocumentSpaceModel,
	type UserModel,
} from './types';
import { HttpError, type HttpRequest, type HttpTransport } from './http';
import { buildMultipart } from './multipart';
import { stripAworkExportHeader } from '../core/markdown';
import type {
	CreateRemoteDoc,
	DocSelection,
	RemoteDoc,
	RemoteDocs,
	RemoteSpace,
	RenameRemoteDoc,
	DocScope,
} from '../core/ports';

const PAGE_SIZE = 100;

export interface TokenProvider {
	/** Returns a usable access token, refreshing it first if needed. */
	getAccessToken(): Promise<string>;
	/** Called once after a 401 so a stale token can be exchanged and retried. */
	forceRefresh(): Promise<string>;
}

/**
 * Typed wrapper over the awork document endpoints. Content always crosses the
 * wire as markdown — awork supports it natively in both directions, so the
 * plugin never has to touch HTML.
 */
export class AworkClient implements RemoteDocs {
	constructor(
		private readonly transport: HttpTransport,
		private readonly tokens: TokenProvider,
		private readonly baseUrl: string = AWORK_API_BASE,
	) {}

	async getCurrentUser(): Promise<UserModel> {
		return this.json<UserModel>({ method: 'GET', url: `${this.baseUrl}/users/me` });
	}

	async listSpaces(): Promise<RemoteSpace[]> {
		const spaces = await this.paged<DocumentSpaceModel>(`${this.baseUrl}/documentspaces`);
		return spaces.map((space) => ({ id: space.id, name: space.name }));
	}

	async listDocuments(selection: DocSelection): Promise<RemoteDoc[]> {
		const sources: Array<Promise<RemoteDoc[]>> = [
			...(selection.includePrivate
				? [this.listScoped(`${this.baseUrl}/me/privatedocuments`, 'private')]
				: []),
			...(selection.includeShared
				? [this.listScoped(`${this.baseUrl}/me/shareddocuments`, 'shared')]
				: []),
			...selection.spaceIds.map((spaceId) =>
				this.listScoped(`${this.baseUrl}/documentspaces/${spaceId}/documents`, 'space'),
			),
		];

		// A doc shared with you inside a space you also sync would appear twice;
		// first listing wins, and space membership is the more specific answer.
		const byId = new Map<string, RemoteDoc>();
		for (const batch of await Promise.all(sources)) {
			for (const doc of batch) {
				const existing = byId.get(doc.id);
				if (!existing || (existing.scope === 'shared' && doc.scope === 'space')) {
					byId.set(doc.id, doc);
				}
			}
		}
		return [...byId.values()];
	}

	async getMarkdown(id: string): Promise<string> {
		const response = await this.json<DocumentContentModel | string>({
			method: 'GET',
			url: `${this.baseUrl}/documents/${id}/content?format=markdown`,
		});
		// The endpoint is documented to return `{ id, content }`, but tolerate a
		// bare string in case `streamAsFile` semantics ever change under us.
		const content = typeof response === 'string' ? response : (response.content ?? '');
		return stripAworkExportHeader(content);
	}

	async putMarkdown(id: string, markdown: string): Promise<RemoteDoc> {
		const multipart = buildMultipart([
			{ name: 'content', value: markdown, filename: 'content.md', contentType: 'text/markdown; charset=utf-8' },
			{ name: 'contentFormat', value: 'markdown' },
		]);
		const document = await this.json<DocumentModel>({
			method: 'PUT',
			url: `${this.baseUrl}/documents/${id}/content`,
			headers: { 'Content-Type': multipart.contentType },
			body: multipart.body,
		});
		return toRemoteDoc(document, scopeOf(document));
	}

	async create(input: CreateRemoteDoc): Promise<RemoteDoc> {
		const fields = [
			{ name: 'name', value: input.name },
			{
				name: 'content',
				value: input.markdown,
				filename: 'content.md',
				contentType: 'text/markdown; charset=utf-8',
			},
			{ name: 'contentFormat', value: 'markdown' },
		];
		if (input.parentId) fields.push({ name: 'parentId', value: input.parentId });
		if (input.spaceId) fields.push({ name: 'documentSpaceId', value: input.spaceId });
		if (input.scope === 'private') fields.push({ name: 'isPrivate', value: 'true' });

		const multipart = buildMultipart(fields);
		const document = await this.json<DocumentModel>({
			method: 'POST',
			url: `${this.baseUrl}/documents`,
			headers: { 'Content-Type': multipart.contentType },
			body: multipart.body,
		});
		return toRemoteDoc(document, input.scope);
	}

	async update(id: string, patch: RenameRemoteDoc): Promise<RemoteDoc> {
		const body: Record<string, unknown> = {};
		if (patch.name !== undefined) body.name = patch.name;
		if (patch.parentId !== undefined) body.parentId = patch.parentId;
		if (patch.spaceId !== undefined) body.documentSpaceId = patch.spaceId;

		const document = await this.json<DocumentModel>({
			method: 'PUT',
			url: `${this.baseUrl}/documents/${id}`,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return toRemoteDoc(document, scopeOf(document));
	}

	async trash(id: string): Promise<void> {
		await this.request({ method: 'DELETE', url: `${this.baseUrl}/documents/${id}` });
	}

	private async listScoped(url: string, scope: DocScope): Promise<RemoteDoc[]> {
		const documents = await this.paged<DocumentModel>(url);
		return documents
			// Project docs ride along in some listings; they are out of scope.
			.filter((document) => !document.projectId && !document.movedToTrashOn)
			.map((document) => toRemoteDoc(document, scope));
	}

	private async paged<T>(url: string): Promise<T[]> {
		const separator = url.includes('?') ? '&' : '?';
		const all: T[] = [];
		for (let page = 1; ; page++) {
			const batch = await this.json<T[]>({
				method: 'GET',
				url: `${url}${separator}page=${page}&pageSize=${PAGE_SIZE}`,
			});
			if (!Array.isArray(batch) || batch.length === 0) return all;
			all.push(...batch);
			if (batch.length < PAGE_SIZE) return all;
		}
	}

	private async json<T>(request: Omit<HttpRequest, 'headers'> & { headers?: Record<string, string> }): Promise<T> {
		const response = await this.request(request);
		if (!response.text) return undefined as T;
		try {
			return JSON.parse(response.text) as T;
		} catch {
			return response.text as unknown as T;
		}
	}

	private async request(request: Omit<HttpRequest, 'headers'> & { headers?: Record<string, string> }) {
		const send = async (token: string) =>
			this.transport.send({
				...request,
				headers: {
					Accept: 'application/json',
					...request.headers,
					Authorization: `Bearer ${token}`,
				},
			});

		let response = await send(await this.tokens.getAccessToken());
		if (response.status === 401) {
			// One shot at a refresh; if the refresh token itself is dead the
			// caller surfaces a re-connect prompt.
			response = await send(await this.tokens.forceRefresh());
		}
		if (response.status >= 400) {
			throw new HttpError(response.status, request.method, request.url, response.text);
		}
		return response;
	}
}

function scopeOf(document: DocumentModel): DocScope {
	if (document.isPrivate) return 'private';
	return document.documentSpaceId ? 'space' : 'shared';
}

function toRemoteDoc(document: DocumentModel, scope: DocScope): RemoteDoc {
	return {
		id: document.id,
		name: document.name,
		scope,
		spaceId: document.documentSpaceId ?? null,
		parentId: document.parentId ?? null,
		updatedOn: document.updatedOn,
		emoji: document.emoji ?? null,
	};
}
