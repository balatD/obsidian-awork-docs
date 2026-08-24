import { conflictPath, nameFromPath, type MappingOptions } from './mapping';
import { applyManagedKeys, hashBody, joinFrontmatter, normalizeBody, splitFrontmatter } from './markdown';
import {
	attachmentName,
	aworkFileUrl,
	findAworkImages,
	findLocalEmbeds,
	imageMimeType,
	localizeImages,
	originalsByName,
	restoreImages,
	type AttachmentMap,
} from './attachments';
import { convertSimpleHtmlTables, type TableConversion } from './tables';
import type { SyncAction, SyncPlan } from './plan';
import type { LocalVault, RemoteDoc, RemoteDocs } from './ports';
import { DEFAULT_CONCURRENCY } from '../api/http';
import { AWORK_APP_BASE } from '../api/types';
import type { DocRecord, SyncState } from './state';

/**
 * Executes a plan. Every action is independent, so one failure is recorded and
 * the rest of the pass continues — a single unreadable document must not stall
 * the whole sync.
 */

export const FRONTMATTER_ID_KEY = 'awork-id';

/**
 * How much awork bookkeeping to leave visible in each note.
 *
 * `none` keeps notes completely clean; identity then rests on the path recorded
 * in the plugin's state instead of an id in the file, which is why the plan
 * falls back to path matching for notes that carry no id.
 */
export type FrontmatterMode = 'full' | 'minimal' | 'none';

export interface ApplyContext {
	remote: RemoteDocs;
	vault: LocalVault;
	state: SyncState;
	mapping: MappingOptions;
	frontmatter: FrontmatterMode;
	tables: TableConversion;
	/** Vault folder for downloaded images; empty disables image download. */
	attachmentFolder: string;
	/**
	 * How many documents to work on at once. Each one costs at least one round
	 * trip, so this is what turns a cold sync from minutes into seconds. Keep it
	 * well under awork's 50 requests/second, which is workspace-wide and shared
	 * with every other integration.
	 */
	concurrency?: number;
	/** Injected so tests get deterministic timestamps. */
	now: () => Date;
	onProgress?: (done: number, total: number) => void;
}



export interface SyncReport {
	pulled: number;
	pushed: number;
	created: number;
	moved: number;
	trashed: number;
	conflicts: number;
	unchanged: number;
	attachments: number;
	uploads: number;
	errors: Array<{ action: string; target: string; message: string }>;
}

export async function applyPlan(plan: SyncPlan, context: ApplyContext): Promise<{ state: SyncState; report: SyncReport }> {
	const state: SyncState = { ...context.state, docs: { ...context.state.docs } };
	const report: SyncReport = {
		pulled: 0,
		pushed: 0,
		created: 0,
		moved: 0,
		trashed: 0,
		conflicts: 0,
		unchanged: plan.unchanged,
		attachments: 0,
		uploads: 0,
		errors: [],
	};

	// Actions touching the same document must stay in order (a move before the
	// pull that rewrites it); different documents are independent.
	const groups = groupByDocument(plan.actions);
	let done = 0;

	await runPool(groups, context.concurrency ?? DEFAULT_CONCURRENCY, async (group) => {
		for (const action of group) {
			try {
				await applyAction(action, state, report, context);
			} catch (error) {
				report.errors.push({
					action: action.kind,
					target: targetOf(action),
					message: error instanceof Error ? error.message : String(error),
				});
			}
			context.onProgress?.(++done, plan.actions.length);
		}
	});

	state.lastSyncAt = context.now().toISOString();
	return { state, report };
}

function groupByDocument(actions: SyncAction[]): SyncAction[][] {
	const groups = new Map<string, SyncAction[]>();
	for (const action of actions) {
		const key = groupKeyOf(action);
		const group = groups.get(key);
		if (group) group.push(action);
		else groups.set(key, [action]);
	}
	return [...groups.values()];
}

function groupKeyOf(action: SyncAction): string {
	if ('doc' in action) return action.doc.id;
	if ('id' in action) return action.id;
	// push-create has no document yet, so its path is its identity.
	return action.path;
}

/**
 * Bounded-concurrency map. Workers pull from a shared cursor rather than being
 * handed fixed slices, so one slow document cannot leave the others idle.
 */
async function runPool<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (cursor < items.length) {
			const item = items[cursor++] as T;
			await worker(item);
		}
	});
	await Promise.all(workers);
}

async function applyAction(
	action: SyncAction,
	state: SyncState,
	report: SyncReport,
	context: ApplyContext,
): Promise<void> {
	const { remote, vault, mapping, now } = context;
	const frontmatterMode = context.frontmatter;

	switch (action.kind) {
		case 'pull-create':
		case 'pull-update': {
			const raw = await remote.getMarkdown(action.doc.id);
			const withTables = convertSimpleHtmlTables(raw, context.tables);
						const { markdown, attachments, urls } = await localize(
				withTables,
				action.path,
				action.doc.id,
				context,
				report,
			);

			await writeNote(vault, action.path, action.doc, markdown, frontmatterMode, {
				// What the last sync left in the file. If the note no longer holds
				// that, someone edited it after the scan decided the remote won —
				// keep their version before it is overwritten.
				guardHash: state.docs[action.doc.id]?.bodyHash,
				mapping,
				stamp: now().toISOString(),
				report,
			});
			state.docs[action.doc.id] = {
				...(await recordFor(action.doc, action.path, markdown, now())),
				attachments,
				attachmentUrls: urls,
			};
			report.pulled++;
			if (action.kind === 'pull-create') report.created++;
			return;
		}

		case 'move-local': {
			// The plan may pair a move with a pull; if the source is already gone
			// the following write recreates it at the destination.
			if (await vault.exists(action.from)) await vault.rename(action.from, action.to);
			const existing = state.docs[action.doc.id];
			if (existing) state.docs[action.doc.id] = { ...existing, path: action.to };
			report.moved++;
			return;
		}

		case 'push-create': {
			const raw = await vault.read(action.path);
			const { frontmatter, body } = splitFrontmatter(raw);
			const created = await remote.create({
				name: action.name,
				markdown: normalizeBody(body),
				scope: action.scope,
				spaceId: action.spaceId,
				parentId: action.parentId,
			});
			state.docs[created.id] = await recordFor(created, action.path, body, now());

			// A file can only attach to a document that exists, so images go up
			// after the create and the body is sent again carrying their real URLs.
			const outgoingNew = await delocalize(body, created.id, action.path, state, context, report);
			const stamped =
				outgoingNew === body
					? created
					: await remote.putMarkdown(created.id, normalizeBody(outgoingNew));

			// Stamp the new id back so the note is tracked even if state is lost.
			await vault.write(
				action.path,
				joinFrontmatter(metaFor(frontmatter, stamped, frontmatterMode), body),
				raw,
			);
			state.docs[created.id] = withAttachments(
				await recordFor(stamped, action.path, body, now()),
				state.docs[created.id],
			);
			report.pushed++;
			report.created++;
			return;
		}

		case 'push-update': {
			const raw = await vault.read(action.path);
			const { frontmatter, body } = splitFrontmatter(raw);
			const outgoing = await delocalize(body, action.doc.id, action.path, state, context, report);
			const updated = await remote.putMarkdown(action.doc.id, normalizeBody(outgoing));
			// Record awork's own post-write timestamp, otherwise the next pass
			// would read our own push back as a remote change.
			await vault.write(action.path, joinFrontmatter(metaFor(frontmatter, updated, frontmatterMode), body));
			state.docs[action.doc.id] = withAttachments(
				await recordFor(updated, action.path, body, now()),
				state.docs[action.doc.id],
			);
			report.pushed++;
			return;
		}

		case 'push-rename': {
			const updated = await remote.update(action.doc.id, {
				name: action.name,
				parentId: action.parentId,
				...(action.spaceId !== null ? { spaceId: action.spaceId } : {}),
			});
			const existing = state.docs[action.doc.id];
			state.docs[action.doc.id] = {
				...(existing ??
					(await recordFor(updated, action.path, splitFrontmatter(await vault.read(action.path)).body, now()))),
				path: action.path,
				name: action.name,
				parentId: action.parentId,
				spaceId: action.spaceId,
				remoteUpdatedOn: updated.updatedOn,
				lastSyncedAt: now().toISOString(),
			};
			report.moved++;
			return;
		}

		case 'conflict': {
			const remoteMarkdown = await remote.getMarkdown(action.doc.id);
			const localRaw = (await vault.exists(action.path)) ? await vault.read(action.path) : '';
			const localBody = splitFrontmatter(localRaw).body;
			const stamp = now().toISOString();

			if (action.winner === 'remote') {
				await vault.write(
					conflictPath(action.path, 'local', stamp, mapping),
					conflictBanner(action.doc, 'local', stamp) + localBody,
				);
				await writeNote(vault, action.path, action.doc, remoteMarkdown, frontmatterMode);
				state.docs[action.doc.id] = await recordFor(action.doc, action.path, remoteMarkdown, now());
			} else {
				await vault.write(
					conflictPath(action.path, 'awork', stamp, mapping),
					conflictBanner(action.doc, 'awork', stamp) + remoteMarkdown,
				);
				const outgoingBody = await delocalize(
					localBody,
					action.doc.id,
					action.path,
					state,
					context,
					report,
				);
				const updated = await remote.putMarkdown(action.doc.id, normalizeBody(outgoingBody));
				const { frontmatter } = splitFrontmatter(localRaw);
				await vault.write(action.path, joinFrontmatter(metaFor(frontmatter, updated, frontmatterMode), localBody));
				state.docs[action.doc.id] = withAttachments(
					await recordFor(updated, action.path, localBody, now()),
					state.docs[action.doc.id],
				);
			}
			report.conflicts++;
			return;
		}

		case 'local-trash': {
			if (await vault.exists(action.path)) await vault.trash(action.path);
			delete state.docs[action.id];
			report.trashed++;
			return;
		}

		case 'remote-trash': {
			await remote.trash(action.id);
			delete state.docs[action.id];
			report.trashed++;
			return;
		}

		case 'touch': {
			state.docs[action.doc.id] = await recordFor(
				action.doc,
				action.path,
				splitFrontmatter(await vault.read(action.path)).body,
				now(),
			);
			return;
		}
	}
}

/**
 * Brings a document's images into the vault and rewrites the embeds to point at
 * them. A file that will not download keeps its original awork reference: a
 * broken remote link beats a broken local one, and the next sync retries.
 */
async function localize(
	markdown: string,
	notePath: string,
	docId: string,
	context: ApplyContext,
	report: SyncReport,
): Promise<{ markdown: string; attachments: AttachmentMap; urls: Record<string, string> }> {
	const images = findAworkImages(markdown);
	if (images.length === 0 || context.attachmentFolder === '') {
		return { markdown, attachments: {}, urls: {} };
	}

	const attachments: AttachmentMap = {};
	const urls: Record<string, string> = {};

	const known = context.state.docs[docId]?.attachments ?? {};

	for (const image of images) {
		if (attachments[image.fileId]) continue;
		// Already in the vault — usually a file this plugin uploaded a moment ago.
		// Re-downloading it would duplicate the attachment under a second name.
		const existing = known[image.fileId];
		if (existing !== undefined && (await context.vault.exists(existing))) {
			attachments[image.fileId] = existing;
			urls[image.fileId] = image.url;
			continue;
		}
		try {
			const file = await context.remote.downloadFile(image.fileId);
			const name = attachmentName(image.fileId, file.contentType, file.contentDisposition);
			const path = `${context.attachmentFolder}/${name}`;
			await context.vault.writeBinary(path, file.bytes);
			attachments[image.fileId] = path;
			urls[image.fileId] = image.url;
			report.attachments++;
		} catch (error) {
			report.errors.push({
				action: 'download-image',
				target: `${notePath} (${image.fileId})`,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { markdown: localizeImages(markdown, attachments), attachments, urls };
}

/**
 * Prepares a body for awork: known attachments get their original file URL back,
 * and images added in Obsidian are uploaded so awork has a real file to point
 * at rather than a wikilink it cannot resolve.
 */
async function delocalize(
	body: string,
	docId: string,
	notePath: string,
	state: SyncState,
	context: ApplyContext,
	report: SyncReport,
): Promise<string> {
	const record = state.docs[docId];
	const restored =
		record?.attachments && record.attachmentUrls
			? restoreImages(body, originalsByName(record.attachments, record.attachmentUrls))
			: body;

	const pending = findLocalEmbeds(restored);
	if (pending.length === 0) return restored;

	const attachments: AttachmentMap = { ...(record?.attachments ?? {}) };
	const urls: Record<string, string> = { ...(record?.attachmentUrls ?? {}) };
	let result = restored;

	for (const embed of pending) {
		const mimeType = imageMimeType(embed.name);
		// Not an image: leave it be rather than turning a PDF into a broken picture.
		if (mimeType === null) continue;
		try {
			const path = await context.vault.resolveEmbed(embed.name, notePath);
			if (path === null) continue;
			const bytes = await context.vault.readBinary(path);
			const fileId = await context.remote.uploadFile(docId, {
				fileName: embed.name,
				mimeType,
				bytes,
			});
			const url = aworkFileUrl(fileId);
			attachments[fileId] = path;
			urls[fileId] = url;
			result = result.split(embed.embed).join(`![${embed.alt}](<${url}>)`);
			report.uploads++;
		} catch (error) {
			report.errors.push({
				action: 'upload-image',
				target: `${notePath} (${embed.name})`,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (record) state.docs[docId] = { ...record, attachments, attachmentUrls: urls };
	return result;
}

interface WriteGuard {
	/** Body hash the last sync recorded for this note. */
	guardHash: string | undefined;
	mapping: MappingOptions;
	stamp: string;
	report: SyncReport;
}

async function writeNote(
	vault: LocalVault,
	path: string,
	doc: RemoteDoc,
	markdown: string,
	mode: FrontmatterMode,
	guard?: WriteGuard,
): Promise<void> {
	const raw = (await vault.exists(path)) ? await vault.read(path) : null;
	const split = raw === null ? { frontmatter: null, body: '' } : splitFrontmatter(raw);

	if (guard?.guardHash !== undefined && raw !== null) {
		const current = await hashBody(split.body);
		if (current !== guard.guardHash) {
			// Edited between the scan and now: this is a conflict the plan could
			// not have seen, so keep the local side rather than discarding it.
			await vault.write(
				conflictPath(path, 'local', guard.stamp, guard.mapping),
				conflictBanner(doc, 'local', guard.stamp) + split.body,
			);
			guard.report.conflicts++;
		}
	}

	// Preserve any frontmatter the user or other plugins put on the note; only
	// the awork-owned keys are rewritten.
	const content = joinFrontmatter(metaFor(split.frontmatter, doc, mode), markdown);
	// `raw` guards the write itself: if the file moved on since it was read a
	// moment ago, the write is refused rather than clobbering the newer text.
	const written = await vault.write(path, content, raw ?? undefined);
	if (!written) {
		guard?.report.errors.push({
			action: 'write-note',
			target: path,
			message: 'The note changed while it was being written; skipped and will sync next pass.',
		});
	}
}

export function metaFor(frontmatter: string | null, doc: RemoteDoc, mode: FrontmatterMode): string {
	return applyManagedKeys(frontmatter, managedKeysFor(doc, mode));
}

function managedKeysFor(doc: RemoteDoc, mode: FrontmatterMode): Record<string, string> {
	switch (mode) {
		case 'none':
			return {};
		case 'minimal':
			return { [FRONTMATTER_ID_KEY]: doc.id };
		case 'full':
			return {
				[FRONTMATTER_ID_KEY]: doc.id,
				'awork-updated': doc.updatedOn,
				'awork-url': `${AWORK_APP_BASE}/documents/${doc.id}`,
			};
	}
}

function conflictBanner(doc: RemoteDoc, side: 'local' | 'awork', stamp: string): string {
	return [
		'---',
		`awork-conflict-of: ${doc.id}`,
		`awork-conflict-side: ${side}`,
		`awork-conflict-at: ${stamp}`,
		'---',
		'',
		`> [!warning] Losing side of a sync conflict (${side}), kept for reference.`,
		'',
		'',
	].join('\n');
}

async function recordFor(doc: RemoteDoc, path: string, body: string, at: Date): Promise<DocRecord> {
	return {
		id: doc.id,
		path,
		name: nameFromPath(path),
		scope: doc.scope,
		spaceId: doc.spaceId,
		parentId: doc.parentId,
		remoteUpdatedOn: doc.updatedOn,
		bodyHash: await hashBody(body),
		lastSyncedAt: at.toISOString(),
	};
}

/**
 * Attachment bookkeeping survives a content write. `recordFor` builds a fresh
 * record from the document alone, so without this an upload would be forgotten
 * and the same image re-uploaded on the next edit.
 */
function withAttachments(base: DocRecord, previous: DocRecord | undefined): DocRecord {
	if (!previous?.attachments && !previous?.attachmentUrls) return base;
	return { ...base, attachments: previous.attachments, attachmentUrls: previous.attachmentUrls };
}

function targetOf(action: SyncAction): string {
	if ('path' in action && typeof action.path === 'string') return action.path;
	if ('to' in action) return action.to;
	if ('name' in action) return action.name;
	return 'id' in action ? action.id : action.kind;
}
