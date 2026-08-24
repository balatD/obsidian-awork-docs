import { conflictPath, nameFromPath, type MappingOptions } from './mapping';
import { applyManagedKeys, hashBody, joinFrontmatter, normalizeBody, splitFrontmatter } from './markdown';
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
			const markdown = await remote.getMarkdown(action.doc.id);
			await writeNote(vault, action.path, action.doc, markdown, frontmatterMode);
			state.docs[action.doc.id] = await recordFor(action.doc, action.path, markdown, now());
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
			// Stamp the new id back so the note is tracked even if state is lost.
			await vault.write(action.path, joinFrontmatter(metaFor(frontmatter, created, frontmatterMode), body));
			state.docs[created.id] = await recordFor(created, action.path, body, now());
			report.pushed++;
			report.created++;
			return;
		}

		case 'push-update': {
			const raw = await vault.read(action.path);
			const { frontmatter, body } = splitFrontmatter(raw);
			const updated = await remote.putMarkdown(action.doc.id, normalizeBody(body));
			// Record awork's own post-write timestamp, otherwise the next pass
			// would read our own push back as a remote change.
			await vault.write(action.path, joinFrontmatter(metaFor(frontmatter, updated, frontmatterMode), body));
			state.docs[action.doc.id] = await recordFor(updated, action.path, body, now());
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
				const updated = await remote.putMarkdown(action.doc.id, normalizeBody(localBody));
				const { frontmatter } = splitFrontmatter(localRaw);
				await vault.write(action.path, joinFrontmatter(metaFor(frontmatter, updated, frontmatterMode), localBody));
				state.docs[action.doc.id] = await recordFor(updated, action.path, localBody, now());
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

async function writeNote(
	vault: LocalVault,
	path: string,
	doc: RemoteDoc,
	markdown: string,
	mode: FrontmatterMode,
): Promise<void> {
	// Preserve any frontmatter the user or other plugins put on the note; only
	// the awork-owned keys are rewritten.
	const existing = (await vault.exists(path)) ? splitFrontmatter(await vault.read(path)).frontmatter : null;
	await vault.write(path, joinFrontmatter(metaFor(existing, doc, mode), markdown));
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

function targetOf(action: SyncAction): string {
	if ('path' in action && typeof action.path === 'string') return action.path;
	if ('to' in action) return action.to;
	if ('name' in action) return action.name;
	return 'id' in action ? action.id : action.kind;
}
