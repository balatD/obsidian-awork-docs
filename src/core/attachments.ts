/**
 * awork embeds images as authenticated, workspace-relative URLs:
 *
 *   ![](</api/v1/files/82e99766-…/download?crop=false&width=1024&…>)
 *
 * Obsidian can render neither — the path is relative to the API host, and the
 * host demands a bearer token an `<img>` tag cannot send. The file has to come
 * into the vault as a real attachment.
 *
 * The original reference is kept in the sync state so a push can put it back
 * verbatim. That is what makes the round trip safe: awork keeps its own file
 * record untouched, and editing a note's text never disturbs its images.
 */

/** Matches the whole embed, capturing alt text and the file id. */
const IMAGE_PATTERN =
	/!\[([^\]]*)\]\(\s*<?((?:https?:\/\/[^/\s)]+)?\/api\/v1\/files\/([0-9a-fA-F-]{36})\/download[^)>\s]*)>?\s*\)/g;

export interface AworkImage {
	/** The complete `![…](…)` embed as it appears in the document. */
	embed: string;
	alt: string;
	url: string;
	fileId: string;
}

export function findAworkImages(markdown: string): AworkImage[] {
	return [...markdown.matchAll(IMAGE_PATTERN)].map((match) => ({
		embed: match[0],
		alt: match[1] ?? '',
		url: match[2] ?? '',
		fileId: match[3] ?? '',
	}));
}

/** fileId → the vault path its attachment was saved to. */
export type AttachmentMap = Record<string, string>;

/**
 * Swaps awork's file URLs for Obsidian embeds. Files that could not be
 * downloaded keep their original reference rather than becoming a broken link.
 */
export function localizeImages(markdown: string, attachments: AttachmentMap): string {
	return markdown.replace(IMAGE_PATTERN, (embed, alt: string, _url: string, fileId: string) => {
		const path = attachments[fileId];
		if (path === undefined) return embed;
		const name = path.slice(path.lastIndexOf('/') + 1);
		// Obsidian resolves an embed by filename wherever the attachment lives,
		// so moving the note or the attachment folder cannot break it.
		return alt ? `![[${name}|${alt}]]` : `![[${name}]]`;
	});
}

const EMBED_PATTERN = /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

/**
 * Puts awork's own file URLs back before a push, so awork never sees a wikilink
 * it cannot resolve. Embeds the plugin did not create are left as they are —
 * they are the user's own attachments, which awork has no record of.
 */
export function restoreImages(markdown: string, originals: Record<string, string>): string {
	return markdown.replace(EMBED_PATTERN, (embed, name: string, alt?: string) => {
		const url = originals[name];
		if (url === undefined) return embed;
		return `![${alt ?? ''}](<${url}>)`;
	});
}

export interface LocalEmbed {
	embed: string;
	name: string;
	alt: string;
}

/** Obsidian-style embeds in a note, in the order they appear. */
export function findLocalEmbeds(markdown: string): LocalEmbed[] {
	return [...markdown.matchAll(EMBED_PATTERN)].map((match) => ({
		embed: match[0],
		name: match[1] ?? '',
		alt: match[2] ?? '',
	}));
}

const MIME_BY_EXTENSION: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	avif: 'image/avif',
	bmp: 'image/bmp',
};

/**
 * Only images are uploaded. awork would happily store any file, but embedding a
 * PDF as an image reference would render as a broken picture there.
 */
export function imageMimeType(filename: string): string | null {
	const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
	return MIME_BY_EXTENSION[extension] ?? null;
}

/** The reference awork uses for one of its own files. */
export function aworkFileUrl(fileId: string): string {
	return `/api/v1/files/${fileId}/download`;
}

/** Inverts an attachment map into filename → original awork URL. */
export function originalsByName(
	attachments: AttachmentMap,
	urls: Record<string, string>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [fileId, path] of Object.entries(attachments)) {
		const url = urls[fileId];
		if (url === undefined) continue;
		result[path.slice(path.lastIndexOf('/') + 1)] = url;
	}
	return result;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/svg+xml': 'svg',
	'image/avif': 'avif',
};

/**
 * Names the attachment file. The file id keeps it unique and lets a later sync
 * recognise its own downloads; `Content-Disposition` supplies a readable name
 * when awork sends one.
 */
export function attachmentName(
	fileId: string,
	contentType: string | undefined,
	contentDisposition: string | undefined,
): string {
	const stated = filenameFrom(contentDisposition);
	const short = fileId.slice(0, 8);
	if (stated !== null) return `${short}-${stated}`;
	const extension = EXTENSION_BY_TYPE[(contentType ?? '').split(';')[0]?.trim() ?? ''] ?? 'bin';
	return `${short}.${extension}`;
}

function filenameFrom(contentDisposition: string | undefined): string | null {
	if (!contentDisposition) return null;
	const encoded = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
	if (encoded?.[1]) return sanitizeFilename(decodeURIComponent(encoded[1]));
	const plain = /filename="?([^";]+)"?/i.exec(contentDisposition);
	return plain?.[1] ? sanitizeFilename(plain[1]) : null;
}

function sanitizeFilename(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|[\]#^]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned === '' ? 'attachment' : cleaned.slice(0, 80);
}
