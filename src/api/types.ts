/**
 * Subset of the awork API v1 schemas this plugin touches.
 * Mirrors https://api.awork.com/openapi/v1 (spec version 1.3.0).
 */

export const AWORK_API_BASE = 'https://api.awork.com/api/v1';
export const AWORK_APP_BASE = 'https://app.awork.com';

export interface DocumentModel {
	id: string;
	name: string;
	createdOn: string;
	updatedOn: string;
	updatedBy?: string;
	documentSpaceId?: string | null;
	parentId?: string | null;
	projectId?: string | null;
	taskId?: string | null;
	emoji?: string | null;
	isPrivate?: boolean;
	order?: number;
	movedToTrashOn?: string | null;
}

export interface DocumentSpaceModel {
	id: string;
	name: string;
	emoji?: string | null;
	color?: string | null;
	order?: number;
	updatedOn: string;
}

export interface DocumentContentModel {
	id: string;
	content: string;
}

export interface UserModel {
	id: string;
	firstName?: string;
	lastName?: string;
	email?: string;
}

/** awork accepts and returns both; we always ask for markdown. */
export type ContentFormat = 'html' | 'markdown';

export interface CreateDocumentInput {
	name: string;
	content: string;
	documentSpaceId?: string | null;
	parentId?: string | null;
	isPrivate?: boolean;
}

export interface UpdateDocumentInput {
	name?: string;
	documentSpaceId?: string | null;
	parentId?: string | null;
}
