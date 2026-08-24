/**
 * Frontmatter handling and body hashing.
 *
 * The plugin stores its sync anchor (`awork-id` and friends) in each note's
 * YAML frontmatter, but awork must never see it — so the frontmatter is split
 * off before a push and merged back after a pull. Change detection hashes the
 * body *without* frontmatter, which is what stops the plugin's own
 * `awork-updated` writes from looking like user edits and re-triggering a push.
 */

export interface SplitNote {
	/** Raw YAML between the `---` fences, without the fences. Null if absent. */
	frontmatter: string | null;
	body: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function splitFrontmatter(raw: string): SplitNote {
	const match = FRONTMATTER_PATTERN.exec(raw);
	if (!match) return { frontmatter: null, body: raw };
	return { frontmatter: match[1] ?? '', body: raw.slice(match[0].length) };
}

export function joinFrontmatter(frontmatter: string | null, body: string): string {
	if (frontmatter === null || frontmatter.trim() === '') return body;
	return `---\n${frontmatter.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n---\n${body}`;
}

/**
 * awork decorates every markdown export with a `name:` frontmatter block naming
 * the document. It is generated on the way out and ignored on the way back in
 * (verified: writing content with a different `name:` does not rename the
 * document), so it is export decoration, not content — the vault should never
 * see it. Stripping it also keeps hashing consistent, since the vault scan would
 * otherwise mistake it for the note's own frontmatter.
 */
export function stripAworkExportHeader(markdown: string): string {
	const { frontmatter, body } = splitFrontmatter(markdown);
	if (!isAworkExportHeader(frontmatter)) return markdown;
	return body.replace(/^\n+/, '');
}

/**
 * True only for a block that is exactly awork's export decoration — a lone
 * `name:` key. A note whose own properties happen to include `name` alongside
 * anything else is the user's, and is left alone.
 */
export function isAworkExportHeader(frontmatter: string | null): boolean {
	if (frontmatter === null) return false;
	const lines = frontmatter
		.replace(/\r\n/g, '\n')
		.split('\n')
		.filter((line) => line.trim() !== '');
	return lines.length === 1 && keyOf(lines[0] as string) === 'name';
}

/** Every frontmatter key this plugin owns and is allowed to remove. */
export const MANAGED_FRONTMATTER_KEYS = ['awork-id', 'awork-updated', 'awork-url'] as const;

/**
 * Writes the plugin's keys and prunes the managed ones it no longer wants, so
 * switching to a leaner property style actually cleans up existing notes.
 * Keys outside `MANAGED_FRONTMATTER_KEYS` are never touched.
 */
export function applyManagedKeys(
	frontmatter: string | null,
	updates: Record<string, string>,
): string {
	const dropped = MANAGED_FRONTMATTER_KEYS.filter((key) => !(key in updates));
	return upsertFrontmatterKeys(removeFrontmatterKeys(frontmatter, dropped), updates);
}

export function removeFrontmatterKeys(
	frontmatter: string | null,
	keys: readonly string[],
): string | null {
	if (frontmatter === null) return null;
	const drop = new Set(keys);
	const kept = frontmatter
		.replace(/\r\n/g, '\n')
		.split('\n')
		.filter((line) => {
			const key = keyOf(line);
			return key === null || !drop.has(key);
		});
	return kept.join('\n');
}

/**
 * Rewrites only the given keys, leaving every other line — including keys the
 * user or other plugins own — byte-for-byte intact.
 */
export function upsertFrontmatterKeys(
	frontmatter: string | null,
	updates: Record<string, string>,
): string {
	const lines = frontmatter === null ? [] : frontmatter.replace(/\r\n/g, '\n').split('\n');
	const remaining = new Map(Object.entries(updates));

	const rewritten = lines.map((line) => {
		const key = keyOf(line);
		if (key === null || !remaining.has(key)) return line;
		const value = remaining.get(key) as string;
		remaining.delete(key);
		return `${key}: ${quoteIfNeeded(value)}`;
	});

	for (const [key, value] of remaining) rewritten.push(`${key}: ${quoteIfNeeded(value)}`);
	return rewritten.filter((line, index) => !(index === 0 && line.trim() === '')).join('\n');
}

export function readFrontmatterKey(frontmatter: string | null, key: string): string | null {
	if (frontmatter === null) return null;
	for (const line of frontmatter.replace(/\r\n/g, '\n').split('\n')) {
		if (keyOf(line) !== key) continue;
		const value = line.slice(line.indexOf(':') + 1).trim();
		return unquote(value) || null;
	}
	return null;
}

/**
 * Line endings and trailing whitespace differ freely between awork's editor and
 * Obsidian without either side having meaningfully changed, so normalise before
 * hashing to keep no-op syncs no-ops.
 */
export function normalizeBody(body: string): string {
	return body.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

export async function hashBody(body: string): Promise<string> {
	const data = new TextEncoder().encode(normalizeBody(body));
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function keyOf(line: string): string | null {
	const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
	return match?.[1] ?? null;
}

function quoteIfNeeded(value: string): string {
	return /^[\w.@/:+-]+$/.test(value) ? value : JSON.stringify(value);
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}
