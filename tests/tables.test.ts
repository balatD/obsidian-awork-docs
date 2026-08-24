import { describe, expect, it } from 'vitest';
import { convertSimpleHtmlTables } from '../src/core/tables';

describe('convertSimpleHtmlTables', () => {
	it('converts a table whose only reason for being HTML is column width', () => {
		const html =
			'<table><tr><th colspan="1" rowspan="1" colwidth="204"><p><strong>Extension</strong></p></th>' +
			'<th colspan="1" rowspan="1"><p><strong>Gesamt</strong></p></th></tr>' +
			'<tr><td colspan="1" rowspan="1" colwidth="204"><p>hlz_socialshare</p></td>' +
			'<td colspan="1" rowspan="1"><p>3,5 h</p></td></tr></table>';

		expect(convertSimpleHtmlTables(html).trim()).toBe(
			['| **Extension** | **Gesamt** |', '| --- | --- |', '| hlz_socialshare | 3,5 h |'].join('\n'),
		);
	});

	it('leaves a merged cell alone rather than corrupting it', () => {
		const html =
			'<table><tr><th colspan="2"><p>Merged</p></th></tr>' +
			'<tr><td><p>a</p></td><td><p>b</p></td></tr></table>';
		expect(convertSimpleHtmlTables(html)).toBe(html);
	});

	it('leaves a rowspan alone', () => {
		const html =
			'<table><tr><th><p>H</p></th><th><p>I</p></th></tr>' +
			'<tr><td rowspan="2"><p>a</p></td><td><p>b</p></td></tr></table>';
		expect(convertSimpleHtmlTables(html)).toBe(html);
	});

	it('leaves a cell holding more than one paragraph alone', () => {
		const html =
			'<table><tr><th><p>H</p></th></tr><tr><td><p>one</p><p>two</p></td></tr></table>';
		expect(convertSimpleHtmlTables(html)).toBe(html);
	});

	it('leaves a table with no header row alone', () => {
		const html = '<table><tr><td><p>a</p></td></tr><tr><td><p>b</p></td></tr></table>';
		expect(convertSimpleHtmlTables(html)).toBe(html);
	});

	it('leaves ragged rows alone', () => {
		const html =
			'<table><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>only one</p></td></tr></table>';
		expect(convertSimpleHtmlTables(html)).toBe(html);
	});

	it('bails on markup it does not understand rather than dropping it', () => {
		const html =
			'<table><tr><th><p>H</p></th></tr><tr><td><p>a<img src="x.png">b</p></td></tr></table>';
		expect(convertSimpleHtmlTables(html)).toBe(html);
	});

	it('carries inline formatting and links across', () => {
		const html =
			'<table><tr><th><p>Was</p></th></tr>' +
			'<tr><td><p><em>kursiv</em> und <a href="https://example.com">Link</a></p></td></tr></table>';
		expect(convertSimpleHtmlTables(html)).toContain('| *kursiv* und [Link](https://example.com) |');
	});

	it('escapes a pipe so it cannot end the cell early', () => {
		const html = '<table><tr><th><p>H</p></th></tr><tr><td><p>a | b</p></td></tr></table>';
		expect(convertSimpleHtmlTables(html)).toContain('| a \\| b |');
	});

	it('decodes entities', () => {
		const html = '<table><tr><th><p>H</p></th></tr><tr><td><p>Fu&amp;Ba&nbsp;r</p></td></tr></table>';
		expect(convertSimpleHtmlTables(html)).toContain('| Fu&Ba r |');
	});

	it('leaves documents without tables untouched', () => {
		expect(convertSimpleHtmlTables('# Title\n\nbody')).toBe('# Title\n\nbody');
	});

	it('converts several tables in one document independently', () => {
		const simple = '<table><tr><th><p>H</p></th></tr><tr><td><p>a</p></td></tr></table>';
		const merged = '<table><tr><th colspan="2"><p>M</p></th></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></table>';
		const result = convertSimpleHtmlTables(`${simple}\n\n${merged}`);
		expect(result).toContain('| H |');
		expect(result).toContain(merged);
	});
});

describe('headerless tables', () => {
	const headerless =
		'<table><tr><td><p>Domain</p></td><td><p>Ablauf</p></td></tr>' +
		'<tr><td><p>example.de</p></td><td><p>2027</p></td></tr></table>';

	it('leaves them alone by default', () => {
		expect(convertSimpleHtmlTables(headerless)).toBe(headerless);
		expect(convertSimpleHtmlTables(headerless, 'header')).toBe(headerless);
	});

	it('promotes the first row when asked, since markdown has no headerless table', () => {
		expect(convertSimpleHtmlTables(headerless, 'promote').trim()).toBe(
			['| Domain | Ablauf |', '| --- | --- |', '| example.de | 2027 |'].join('\n'),
		);
	});

	it('still refuses a merged cell even when promoting', () => {
		const merged =
			'<table><tr><td colspan="2"><p>M</p></td></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></table>';
		expect(convertSimpleHtmlTables(merged, 'promote')).toBe(merged);
	});

	it('converts nothing at all when switched off', () => {
		const withHeader = '<table><tr><th><p>H</p></th></tr><tr><td><p>a</p></td></tr></table>';
		expect(convertSimpleHtmlTables(withHeader, 'off')).toBe(withHeader);
	});
});
