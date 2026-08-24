/**
 * awork emits most tables as markdown pipe tables, but falls back to raw
 * `<table>` HTML whenever its editor holds something markdown cannot express —
 * in practice a resized column (`colwidth`), a merged cell, or block content in
 * a cell. Obsidian renders that HTML, but you cannot edit it as a table.
 *
 * Only the tables where the fallback was unnecessary are converted back: the
 * ones whose sole reason for being HTML is presentational `colwidth`. Anything
 * with a real merge or structure a pipe table cannot hold is left untouched,
 * because a lossy conversion would silently drop the user's data.
 *
 * Pipe tables survive the round trip — awork parses them back into real tables —
 * so a converted table pushes back cleanly, losing only the stored column width.
 */

const TABLE_PATTERN = /<table[^>]*>[\s\S]*?<\/table>/gi;
const ROW_PATTERN = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_PATTERN = /<(th|td)([^>]*)>([\s\S]*?)<\/\1>/gi;
const SPAN_PATTERN = /\b(colspan|rowspan)\s*=\s*"(\d+)"/gi;

/**
 * `off` leaves every table as awork sent it. `header` converts only tables that
 * already mark a header row. `promote` additionally turns the first row of a
 * headerless table into one — markdown has no headerless table, so this is the
 * only way those become editable, at the cost of a real (small) change to the
 * document if it is ever pushed back.
 */
export type TableConversion = 'off' | 'header' | 'promote';

export function convertSimpleHtmlTables(
	markdown: string,
	mode: TableConversion = 'header',
): string {
	if (mode === 'off' || !markdown.includes('<table')) return markdown;
	return markdown.replace(TABLE_PATTERN, (table) => convertTable(table, mode) ?? table);
}

/** Returns null when the table cannot be expressed as a pipe table. */
function convertTable(html: string, mode: TableConversion): string | null {
	const rows: string[][] = [];
	let headerCells = 0;

	for (const rowMatch of html.matchAll(ROW_PATTERN)) {
		const cells: string[] = [];
		let isHeaderRow = false;

		for (const cellMatch of (rowMatch[1] ?? '').matchAll(CELL_PATTERN)) {
			const [, tag = '', attributes = '', inner = ''] = cellMatch;
			// A merged cell has no pipe-table equivalent.
			for (const span of attributes.matchAll(SPAN_PATTERN)) {
				if (Number(span[2]) > 1) return null;
			}
			const text = cellText(inner);
			if (text === null) return null;
			if (tag.toLowerCase() === 'th') isHeaderRow = true;
			cells.push(text);
		}

		if (cells.length === 0) return null;
		if (rows.length === 0 && isHeaderRow) headerCells = cells.length;
		rows.push(cells);
	}

	if (rows.length < 2) return null;
	if (headerCells === 0) {
		// No <th> anywhere: only usable if the caller accepts promoting row one.
		if (mode !== 'promote') return null;
		headerCells = (rows[0] as string[]).length;
	}
	if (rows.some((row) => row.length !== headerCells)) return null;

	const [header, ...body] = rows as [string[], ...string[][]];
	const lines = [
		`| ${header.join(' | ')} |`,
		`| ${header.map(() => '---').join(' | ')} |`,
		...body.map((row) => `| ${row.join(' | ')} |`),
	];
	return `\n\n${lines.join('\n')}\n\n`;
}

/**
 * Flattens one cell's HTML to inline markdown, or null when it holds something
 * a single table cell cannot carry.
 */
function cellText(inner: string): string | null {
	const paragraphs = [...inner.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1] ?? '');
	// awork always wraps cell content in <p>; more than one means a real block
	// structure that a pipe table would flatten and corrupt.
	const content = paragraphs.length === 0 ? inner : paragraphs.length === 1 ? (paragraphs[0] as string) : null;
	if (content === null) return null;

	const text = content
		.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
		.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
		.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
		.replace(/<s[^>]*>([\s\S]*?)<\/s>/gi, '~~$1~~')
		.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

	// Any tag left over is one this converter does not understand.
	if (/<[a-z/][^>]*>/i.test(text)) return null;

	return decodeEntities(text)
		.replace(/\s+/g, ' ')
		.trim()
		// A literal pipe would end the cell early.
		.replace(/\|/g, '\\|');
}

function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}
