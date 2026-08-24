import { describe, expect, it } from 'vitest';
import {
	hashBody,
	joinFrontmatter,
	isAworkExportHeader,
	normalizeBody,
	readFrontmatterKey,
	stripAworkExportHeader,
	splitFrontmatter,
	upsertFrontmatterKeys,
} from '../src/core/markdown';

describe('frontmatter', () => {
	it('splits a note into frontmatter and body', () => {
		const note = '---\nawork-id: abc\ntags: [ops]\n---\n# Title\n\ntext';
		const { frontmatter, body } = splitFrontmatter(note);
		expect(frontmatter).toBe('awork-id: abc\ntags: [ops]');
		expect(body).toBe('# Title\n\ntext');
	});

	it('treats a note without frontmatter as all body', () => {
		expect(splitFrontmatter('# Title').frontmatter).toBeNull();
		expect(splitFrontmatter('# Title').body).toBe('# Title');
	});

	it('does not mistake a horizontal rule for frontmatter', () => {
		const note = 'intro\n\n---\n\nafter the rule';
		expect(splitFrontmatter(note).frontmatter).toBeNull();
	});

	it('rewrites managed keys and leaves the rest untouched', () => {
		const updated = upsertFrontmatterKeys('tags: [ops]\nawork-id: old\naliases: [x]', {
			'awork-id': 'new',
			'awork-updated': '2026-08-24T10:00:00Z',
		});
		expect(updated).toBe(
			'tags: [ops]\nawork-id: new\naliases: [x]\nawork-updated: 2026-08-24T10:00:00Z',
		);
	});

	it('creates frontmatter when the note had none', () => {
		expect(upsertFrontmatterKeys(null, { 'awork-id': 'abc' })).toBe('awork-id: abc');
	});

	it('quotes values that are not plain scalars', () => {
		expect(upsertFrontmatterKeys(null, { 'awork-id': 'a b' })).toBe('awork-id: "a b"');
	});

	it('reads a key back out, quoted or not', () => {
		expect(readFrontmatterKey('awork-id: abc', 'awork-id')).toBe('abc');
		expect(readFrontmatterKey('awork-id: "a b"', 'awork-id')).toBe('a b');
		expect(readFrontmatterKey('other: 1', 'awork-id')).toBeNull();
		expect(readFrontmatterKey(null, 'awork-id')).toBeNull();
	});

	it('round-trips through split and join', () => {
		const note = '---\nawork-id: abc\n---\nbody text';
		const { frontmatter, body } = splitFrontmatter(note);
		expect(joinFrontmatter(frontmatter, body)).toBe(note);
	});

	it('omits the fences when there is no frontmatter to write', () => {
		expect(joinFrontmatter(null, 'body')).toBe('body');
		expect(joinFrontmatter('', 'body')).toBe('body');
	});
});

describe('body hashing', () => {
	it('ignores line endings and trailing whitespace', async () => {
		const a = await hashBody('line one   \r\nline two\r\n\r\n');
		const b = await hashBody('line one\nline two');
		expect(a).toBe(b);
	});

	it('still notices real edits', async () => {
		expect(await hashBody('one')).not.toBe(await hashBody('two'));
	});

	it('normalizes without destroying inner blank lines', () => {
		expect(normalizeBody('a\n\nb\n\n')).toBe('a\n\nb');
	});
});

describe('awork export header', () => {
	it('removes the lone name block awork prepends', () => {
		expect(stripAworkExportHeader('---\nname: Ziele\n---\n\n1. Punkt')).toBe('1. Punkt');
	});

	it('keeps frontmatter that carries anything besides name', () => {
		const note = '---\nname: Ziele\nawork-id: abc\n---\n\nbody';
		expect(stripAworkExportHeader(note)).toBe(note);
	});

	it('leaves a note without frontmatter untouched', () => {
		expect(stripAworkExportHeader('# Title\n\nbody')).toBe('# Title\n\nbody');
	});

	it('does not eat a horizontal rule further down the document', () => {
		const note = '---\nname: Ziele\n---\n\nintro\n\n---\n\nrest';
		expect(stripAworkExportHeader(note)).toBe('intro\n\n---\n\nrest');
	});

	it('recognises only the exact export shape', () => {
		expect(isAworkExportHeader('name: Ziele')).toBe(true);
		expect(isAworkExportHeader('name: Ziele\ntags: [x]')).toBe(false);
		expect(isAworkExportHeader('awork-id: abc')).toBe(false);
		expect(isAworkExportHeader(null)).toBe(false);
	});
});
