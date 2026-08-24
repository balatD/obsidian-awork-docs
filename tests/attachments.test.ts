import { beforeEach, describe, expect, it } from 'vitest';
import { defaultMappingOptions } from '../src/core/mapping';
import { emptyState, type SyncState } from '../src/core/state';
import { splitFrontmatter } from '../src/core/markdown';
import { findAworkImages, localizeImages, restoreImages } from '../src/core/attachments';
import { runSync } from '../src/sync-service';
import { FakeRemote, InMemoryVault, TestClock } from './fakes';

const FILE_ID = '82e99766-fa21-4ef4-abf5-cf0fe2e8ca41';
const URL = `/api/v1/files/${FILE_ID}/download?crop=false&width=1024&height=1024&v=1778848806000`;
const EMBED = `![](<${URL}>)`;

describe('finding awork images', () => {
	it('matches the angle-bracketed relative form awork emits', () => {
		const found = findAworkImages(`before\n\n${EMBED}\n\nafter`);
		expect(found).toHaveLength(1);
		expect(found[0]?.fileId).toBe(FILE_ID);
		expect(found[0]?.url).toBe(URL);
	});

	it('matches an absolute url too', () => {
		const absolute = `![alt](https://api.awork.com/api/v1/files/${FILE_ID}/download?v=1)`;
		expect(findAworkImages(absolute)[0]?.fileId).toBe(FILE_ID);
		expect(findAworkImages(absolute)[0]?.alt).toBe('alt');
	});

	it('ignores ordinary images and links', () => {
		expect(findAworkImages('![](photo.png) and [text](/api/v1/files/x/download)')).toHaveLength(0);
	});

	it('round-trips an embed back to the exact url it came from', () => {
		const local = localizeImages(EMBED, { [FILE_ID]: 'awork/_attachments/82e99766.jpg' });
		expect(local).toBe('![[82e99766.jpg]]');
		const restored = restoreImages(local, { '82e99766.jpg': URL });
		expect(restored).toBe(EMBED);
	});

	it('leaves an embed alone when its file could not be downloaded', () => {
		expect(localizeImages(EMBED, {})).toBe(EMBED);
	});

	it('leaves the user\'s own attachments alone on the way out', () => {
		expect(restoreImages('![[my-own-photo.png]]', {})).toBe('![[my-own-photo.png]]');
	});
});

describe('images through a sync', () => {
	const SPACE_ID = 'space-eng';
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
		remote.files.set(FILE_ID, {
			bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe1]).buffer,
			contentType: 'image/jpeg',
			contentDisposition: 'attachment; filename="screenshot.jpg"',
		});
	});

	const sync = async (attachmentFolder = 'awork/_attachments') =>
		runSync({
			remote,
			vault,
			mapping: defaultMappingOptions,
			selection: { spaceIds: [SPACE_ID], includePrivate: true, includeShared: true },
			deletionPolicy: 'ignore',
			frontmatter: 'minimal',
			tables: 'header',
			attachmentFolder,
			loadState: () => state,
			saveState: async (next) => {
				state = next;
			},
			now: () => clock.now(),
		});

	const path = 'awork/Engineering/Doc.md';

	it('downloads the image and rewrites the embed', async () => {
		remote.seed({ id: 'doc-a', name: 'Doc', spaceId: SPACE_ID }, `Text\n\n${EMBED}`);

		const report = await sync();

		expect(report.attachments).toBe(1);
		expect(vault.binary.has('awork/_attachments/82e99766-screenshot.jpg')).toBe(true);
		expect(await vault.read(path)).toContain('![[82e99766-screenshot.jpg]]');
	});

	it('puts awork\'s own url back when the note is pushed', async () => {
		remote.seed({ id: 'doc-a', name: 'Doc', spaceId: SPACE_ID }, `Text\n\n${EMBED}`);
		await sync();

		clock.advance(60_000);
		const { frontmatter } = splitFrontmatter(await vault.read(path));
		vault.edit(path, `---\n${frontmatter}\n---\nEdited\n\n![[82e99766-screenshot.jpg]]`);
		await sync();

		// awork must receive its own file reference, never an Obsidian wikilink.
		expect(await remote.getMarkdown('doc-a')).toBe(`Edited\n\n${EMBED}`);
	});

	it('does not re-download an unchanged image on every pass', async () => {
		remote.seed({ id: 'doc-a', name: 'Doc', spaceId: SPACE_ID }, `Text\n\n${EMBED}`);
		await sync();
		await sync();

		expect(remote.downloads).toEqual([FILE_ID]);
	});

	it('keeps the original link when downloading fails', async () => {
		remote.files.clear();
		remote.seed({ id: 'doc-a', name: 'Doc', spaceId: SPACE_ID }, `Text\n\n${EMBED}`);

		const report = await sync();

		expect(await vault.read(path)).toContain(URL);
		expect(report.errors.map((e) => e.action)).toEqual(['download-image']);
	});

	it('leaves images untouched when no folder is configured', async () => {
		remote.seed({ id: 'doc-a', name: 'Doc', spaceId: SPACE_ID }, `Text\n\n${EMBED}`);

		const report = await sync('');

		expect(report.attachments).toBe(0);
		expect(remote.downloads).toEqual([]);
		expect(await vault.read(path)).toContain(URL);
	});

	it('does not treat downloaded attachments as notes to push', async () => {
		remote.seed({ id: 'doc-a', name: 'Doc', spaceId: SPACE_ID }, `Text\n\n${EMBED}`);
		await sync();

		const second = await sync();

		expect(second.created).toBe(0);
		expect(remote.docs.size).toBe(1);
	});
});

describe('images added in Obsidian', () => {
	const SPACE_ID = 'space-eng';
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

	const sync = async () =>
		runSync({
			remote,
			vault,
			mapping: defaultMappingOptions,
			selection: { spaceIds: [SPACE_ID], includePrivate: true, includeShared: true },
			deletionPolicy: 'ignore',
			frontmatter: 'minimal',
			tables: 'header',
			attachmentFolder: 'awork/_attachments',
			loadState: () => state,
			saveState: async (next) => {
				state = next;
			},
			now: () => clock.now(),
		});

	const path = 'awork/Engineering/Doc.md';
	const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

	it('uploads a pasted image and sends awork a real file reference', async () => {
		remote.seed({ id: 'doc-a', name: 'Doc', spaceId: SPACE_ID }, 'body');
		await sync();

		clock.advance(60_000);
		await vault.writeBinary('awork/_attachments/pasted.png', png());
		const { frontmatter } = splitFrontmatter(await vault.read(path));
		vault.edit(path, `---\n${frontmatter}\n---\nSee this:\n\n![[pasted.png]]`);

		const report = await sync();

		expect(report.uploads).toBe(1);
		expect(remote.uploads[0]).toMatchObject({ documentId: 'doc-a', fileName: 'pasted.png' });
		const pushed = await remote.getMarkdown('doc-a');
		expect(pushed).toMatch(/!\[\]\(<\/api\/v1\/files\/file-\d+\/download>\)/);
		expect(pushed).not.toContain('![[');
	});

	it('does not upload the same image again on the next edit', async () => {
		remote.seed({ id: 'doc-a', name: 'Doc', spaceId: SPACE_ID }, 'body');
		await sync();
		clock.advance(60_000);
		await vault.writeBinary('awork/_attachments/pasted.png', png());
		let { frontmatter } = splitFrontmatter(await vault.read(path));
		vault.edit(path, `---\n${frontmatter}\n---\n![[pasted.png]]`);
		await sync();

		clock.advance(60_000);
		({ frontmatter } = splitFrontmatter(await vault.read(path)));
		vault.edit(path, `---\n${frontmatter}\n---\nMore text\n\n![[pasted.png]]`);
		await sync();

		expect(remote.uploads).toHaveLength(1);
	});

	it('uploads images on a note created in Obsidian', async () => {
		await vault.writeBinary('awork/_attachments/shot.png', png());
		vault.edit('awork/Engineering/Fresh.md', 'New note\n\n![[shot.png]]');

		const report = await sync();

		expect(report.uploads).toBe(1);
		const created = [...remote.docs.values()].find((d) => d.name === 'Fresh');
		expect(await remote.getMarkdown(created!.id)).toContain('/api/v1/files/');
	});

	it('leaves a non-image embed alone', async () => {
		remote.seed({ id: 'doc-a', name: 'Doc', spaceId: SPACE_ID }, 'body');
		await sync();
		clock.advance(60_000);
		await vault.writeBinary('awork/_attachments/spec.pdf', png());
		const { frontmatter } = splitFrontmatter(await vault.read(path));
		vault.edit(path, `---\n${frontmatter}\n---\n![[spec.pdf]]`);

		const report = await sync();

		expect(report.uploads).toBe(0);
		expect(await remote.getMarkdown('doc-a')).toContain('![[spec.pdf]]');
	});

	it('reports an embed it cannot resolve instead of failing the sync', async () => {
		remote.seed({ id: 'doc-a', name: 'Doc', spaceId: SPACE_ID }, 'body');
		await sync();
		clock.advance(60_000);
		const { frontmatter } = splitFrontmatter(await vault.read(path));
		vault.edit(path, `---\n${frontmatter}\n---\n![[missing.png]]`);

		const report = await sync();

		expect(report.uploads).toBe(0);
		expect(report.errors).toHaveLength(0);
		expect(await remote.getMarkdown('doc-a')).toContain('![[missing.png]]');
	});
});
