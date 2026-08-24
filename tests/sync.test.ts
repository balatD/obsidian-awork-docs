import { beforeEach, describe, expect, it } from 'vitest';
import { defaultMappingOptions } from '../src/core/mapping';
import type { DeletionPolicy } from '../src/core/plan';
import { emptyState, type SyncState } from '../src/core/state';
import type { FrontmatterMode } from '../src/core/sync-engine';
import { splitFrontmatter } from '../src/core/markdown';
import { runSync } from '../src/sync-service';
import { FakeRemote, InMemoryVault, TestClock } from './fakes';

const SPACE_ID = 'space-eng';
const mapping = defaultMappingOptions;

describe('two-way sync', () => {
	let clock: TestClock;
	let remote: FakeRemote;
	let vault: InMemoryVault;
	let state: SyncState;

	beforeEach(() => {
		clock = new TestClock();
		remote = new FakeRemote(clock);
		vault = new InMemoryVault(clock);
		state = emptyState();
		remote.addSpace(SPACE_ID, 'Engineering');
	});

	const sync = async (deletionPolicy: DeletionPolicy = 'ignore', frontmatter: FrontmatterMode = 'minimal') =>
		runSync({
			remote,
			vault,
			mapping,
			selection: { spaceIds: [SPACE_ID], includePrivate: true, includeShared: true },
			deletionPolicy,
			frontmatter,
			loadState: () => state,
			saveState: async (next) => {
				state = next;
			},
			now: () => clock.now(),
		});

	it('pulls a new awork document into the vault with its id in frontmatter', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, '# Runbook\n\nStep one.');

		const report = await sync();

		expect(report.pulled).toBe(1);
		const note = await vault.read('awork/Engineering/Runbook.md');
		expect(note).toContain('awork-id: doc-a');
		expect(note).toContain('# Runbook');
	});

	it('is a no-op when neither side changed', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await sync();

		const second = await sync();

		expect(second.unchanged).toBe(1);
		expect(second.pulled).toBe(0);
		expect(second.pushed).toBe(0);
	});

	it('pushes a local edit without leaking frontmatter into awork', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'old body');
		await sync();

		clock.advance(60_000);
		const path = 'awork/Engineering/Runbook.md';
		const { frontmatter } = splitFrontmatter(await vault.read(path));
		vault.edit(path, `---\n${frontmatter}\n---\nnew body`);

		const report = await sync();

		expect(report.pushed).toBe(1);
		const pushed = await remote.getMarkdown('doc-a');
		expect(pushed).toBe('new body');
		expect(pushed).not.toContain('awork-id');
	});

	it('does not push again after its own write-back', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'old body');
		await sync();
		clock.advance(60_000);
		const path = 'awork/Engineering/Runbook.md';
		const { frontmatter } = splitFrontmatter(await vault.read(path));
		vault.edit(path, `---\n${frontmatter}\n---\nnew body`);
		await sync();

		// The push refreshed awork-updated in the note; that must not read as an edit.
		const third = await sync();

		expect(third.pushed).toBe(0);
		expect(third.pulled).toBe(0);
		expect(third.unchanged).toBe(1);
	});

	it('creates an awork document from an untracked note', async () => {
		vault.edit('awork/Engineering/Fresh idea.md', 'Just thought of this.');

		const report = await sync();

		expect(report.created).toBe(1);
		const created = [...remote.docs.values()].find((doc) => doc.name === 'Fresh idea');
		expect(created).toBeDefined();
		expect(created?.spaceId).toBe(SPACE_ID);
		expect(await remote.getMarkdown(created!.id)).toBe('Just thought of this.');
		expect(await vault.read('awork/Engineering/Fresh idea.md')).toContain(`awork-id: ${created!.id}`);
	});

	it('nests a note under its folder note as a child document', async () => {
		const parent = remote.seed({ id: 'doc-parent', name: 'Handbook', spaceId: SPACE_ID }, 'parent');
		await sync();
		vault.edit('awork/Engineering/Handbook/Onboarding.md', 'child body');

		await sync();

		const child = [...remote.docs.values()].find((doc) => doc.name === 'Onboarding');
		expect(child?.parentId).toBe(parent.id);
	});

	it('mirrors a remote rename by moving the note', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await sync();

		clock.advance(60_000);
		await remote.update('doc-a', { name: 'Operations runbook' });
		const report = await sync();

		expect(report.moved).toBe(1);
		expect(await vault.exists('awork/Engineering/Operations runbook.md')).toBe(true);
		expect(await vault.exists('awork/Engineering/Runbook.md')).toBe(false);
	});

	it('mirrors a local rename onto the awork document', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await sync();

		clock.advance(60_000);
		await vault.rename('awork/Engineering/Runbook.md', 'awork/Engineering/Playbook.md');
		await sync();

		expect(remote.docs.get('doc-a')?.name).toBe('Playbook');
	});

	it('keeps the newer side and archives the loser when both changed', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'original');
		await sync();
		const path = 'awork/Engineering/Runbook.md';

		clock.advance(60_000);
		const { frontmatter } = splitFrontmatter(await vault.read(path));
		vault.edit(path, `---\n${frontmatter}\n---\nlocal edit`);

		// awork edited afterwards, so awork wins.
		clock.advance(60_000);
		remote.editRemotely('doc-a', 'remote edit');

		const report = await sync();

		expect(report.conflicts).toBe(1);
		expect(await vault.read(path)).toContain('remote edit');
		const archived = [...vault.files.keys()].filter((p) => p.startsWith('awork/_conflicts/'));
		expect(archived).toHaveLength(1);
		expect(await vault.read(archived[0]!)).toContain('local edit');
	});

	it('keeps the local side when it is the newer one', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'original');
		await sync();
		const path = 'awork/Engineering/Runbook.md';

		clock.advance(60_000);
		remote.editRemotely('doc-a', 'remote edit');

		clock.advance(60_000);
		const { frontmatter } = splitFrontmatter(await vault.read(path));
		vault.edit(path, `---\n${frontmatter}\n---\nlocal edit`);

		const report = await sync();

		expect(report.conflicts).toBe(1);
		expect(await remote.getMarkdown('doc-a')).toBe('local edit');
		const archived = [...vault.files.keys()].filter((p) => p.startsWith('awork/_conflicts/'));
		expect(await vault.read(archived[0]!)).toContain('remote edit');
	});

	it('trashes the note when the document disappears from awork', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await sync();

		remote.docs.delete('doc-a');
		const report = await sync();

		expect(report.trashed).toBe(1);
		expect(vault.trashed).toEqual(['awork/Engineering/Runbook.md']);
		expect(state.docs['doc-a']).toBeUndefined();
	});

	it('restores a locally deleted note under the default deletion policy', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await sync();

		vault.files.delete('awork/Engineering/Runbook.md');
		await sync();

		expect(await vault.exists('awork/Engineering/Runbook.md')).toBe(true);
	});

	it('trashes the awork document when the policy mirrors deletions', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await sync('mirror');

		vault.files.delete('awork/Engineering/Runbook.md');
		await sync('mirror');

		expect(remote.trashed).toEqual(['doc-a']);
	});

	it('adopts an existing note instead of duplicating it when state is lost', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await sync();

		state = emptyState();
		const report = await sync();

		expect(report.created).toBe(0);
		expect(remote.docs.size).toBe(1);
		expect([...vault.files.keys()]).toEqual(['awork/Engineering/Runbook.md']);
	});

	it('preserves unrelated frontmatter keys across a pull', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await sync();
		const path = 'awork/Engineering/Runbook.md';
		const { frontmatter } = splitFrontmatter(await vault.read(path));
		vault.edit(path, `---\n${frontmatter}\ntags: [ops]\n---\nbody`);

		clock.advance(60_000);
		remote.editRemotely('doc-a', 'updated body');
		await sync();

		const note = await vault.read(path);
		expect(note).toContain('tags: [ops]');
		expect(note).toContain('updated body');
	});

	it('routes private and shared documents into their own folders', async () => {
		remote.seed({ id: 'doc-p', name: 'Scratch', scope: 'private' }, 'mine');
		remote.seed({ id: 'doc-s', name: 'Team plan', scope: 'shared' }, 'theirs');

		await sync();

		expect(await vault.exists('awork/Private/Scratch.md')).toBe(true);
		expect(await vault.exists('awork/Shared with me/Team plan.md')).toBe(true);
	});

	it('never creates awork documents from the shared folder', async () => {
		vault.edit('awork/Shared with me/Not mine.md', 'nope');

		const report = await sync();

		expect(report.created).toBe(0);
		expect(remote.docs.size).toBe(0);
	});
});

describe('awork properties in notes', () => {
	let clock: TestClock;
	let remote: FakeRemote;
	let vault: InMemoryVault;
	let state: SyncState;

	beforeEach(() => {
		clock = new TestClock();
		remote = new FakeRemote(clock);
		vault = new InMemoryVault(clock);
		state = emptyState();
		remote.addSpace(SPACE_ID, 'Engineering');
	});

	const syncWith = async (frontmatter: FrontmatterMode) =>
		runSync({
			remote,
			vault,
			mapping,
			selection: { spaceIds: [SPACE_ID], includePrivate: true, includeShared: true },
			deletionPolicy: 'ignore',
			frontmatter,
			loadState: () => state,
			saveState: async (next) => {
				state = next;
			},
			now: () => clock.now(),
		});

	const path = 'awork/Engineering/Runbook.md';

	it('writes only the id in the minimal style', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await syncWith('minimal');

		const note = await vault.read(path);
		expect(note).toContain('awork-id: doc-a');
		expect(note).not.toContain('awork-url');
		expect(note).not.toContain('awork-updated');
	});

	it('writes no properties at all in the none style', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, '# Runbook');
		await syncWith('none');

		expect(await vault.read(path)).toBe('# Runbook');
	});

	it('still tracks a note that carries no id, via its recorded path', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await syncWith('none');

		clock.advance(60_000);
		vault.edit(path, 'edited without any frontmatter');
		const report = await syncWith('none');

		// Matched by path rather than duplicated into a second awork document.
		expect(report.created).toBe(0);
		expect(remote.docs.size).toBe(1);
		expect(await remote.getMarkdown('doc-a')).toBe('edited without any frontmatter');
	});

	it('prunes properties that a leaner style no longer wants', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await syncWith('full');
		expect(await vault.read(path)).toContain('awork-url');

		clock.advance(60_000);
		remote.editRemotely('doc-a', 'new body');
		await syncWith('minimal');

		const note = await vault.read(path);
		expect(note).toContain('awork-id: doc-a');
		expect(note).not.toContain('awork-url');
		expect(note).not.toContain('awork-updated');
	});

	it('keeps user properties while pruning its own', async () => {
		remote.seed({ id: 'doc-a', name: 'Runbook', spaceId: SPACE_ID }, 'body');
		await syncWith('full');
		const { frontmatter } = splitFrontmatter(await vault.read(path));
		vault.edit(path, `---\n${frontmatter}\ntags: [ops]\n---\nbody`);

		clock.advance(60_000);
		remote.editRemotely('doc-a', 'new body');
		await syncWith('none');

		const note = await vault.read(path);
		expect(note).toContain('tags: [ops]');
		expect(note).not.toContain('awork-id');
	});
});

describe('scan caching', () => {
	it('re-reads only the notes whose mtime moved', async () => {
		const clock = new TestClock();
		const remote = new FakeRemote(clock);
		const vault = new InMemoryVault(clock);
		let state = emptyState();
		remote.addSpace(SPACE_ID, 'Engineering');
		remote.seed({ id: 'doc-a', name: 'A', spaceId: SPACE_ID }, 'a');
		remote.seed({ id: 'doc-b', name: 'B', spaceId: SPACE_ID }, 'b');

		const sync = async () =>
			runSync({
				remote,
				vault,
				mapping,
				selection: { spaceIds: [SPACE_ID], includePrivate: true, includeShared: true },
				deletionPolicy: 'ignore',
				frontmatter: 'minimal',
				loadState: () => state,
				saveState: async (next) => {
					state = next;
				},
				now: () => clock.now(),
			});

		await sync();
		await sync();

		// Everything is cached now; touch one note and count what gets read.
		clock.advance(60_000);
		vault.edit('awork/Engineering/A.md', 'changed');
		const reads: string[] = [];
		const originalRead = vault.readCached.bind(vault);
		vault.readCached = async (path: string) => {
			reads.push(path);
			return originalRead(path);
		};

		await sync();

		expect(reads).toEqual(['awork/Engineering/A.md']);
	});
});
