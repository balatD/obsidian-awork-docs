/**
 * Obsidian's `requestUrl` cannot send a FormData object — it takes a string or
 * ArrayBuffer body — so multipart payloads for the document content endpoints
 * are assembled by hand.
 */

const encoder = new TextEncoder();

export interface MultipartField {
	name: string;
	value: string;
	/** Present for the file part; awork expects `content` as a file upload. */
	filename?: string;
	contentType?: string;
}

export interface MultipartBody {
	contentType: string;
	body: ArrayBuffer;
}

export function buildMultipart(fields: MultipartField[]): MultipartBody {
	const boundary = `----awork-obsidian-${randomToken()}`;
	const chunks: Uint8Array[] = [];

	for (const field of fields) {
		let header = `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"`;
		if (field.filename !== undefined) header += `; filename="${field.filename}"`;
		header += '\r\n';
		if (field.contentType) header += `Content-Type: ${field.contentType}\r\n`;
		header += '\r\n';
		chunks.push(encoder.encode(header));
		chunks.push(encoder.encode(field.value));
		chunks.push(encoder.encode('\r\n'));
	}
	chunks.push(encoder.encode(`--${boundary}--\r\n`));

	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return {
		contentType: `multipart/form-data; boundary=${boundary}`,
		body: body.buffer as ArrayBuffer,
	};
}

function randomToken(): string {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface BinaryField {
	name: string;
	value: string | ArrayBuffer;
	filename?: string;
	contentType?: string;
}

/**
 * Same as `buildMultipart`, but a field's value may be raw bytes — file uploads
 * must not be pushed through a text encoder.
 */
export function buildMultipartBinary(fields: BinaryField[]): MultipartBody {
	const boundary = `----awork-obsidian-${randomToken()}`;
	const chunks: Uint8Array[] = [];

	for (const field of fields) {
		let header = `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"`;
		if (field.filename !== undefined) header += `; filename="${field.filename}"`;
		header += '\r\n';
		if (field.contentType) header += `Content-Type: ${field.contentType}\r\n`;
		header += '\r\n';
		chunks.push(encoder.encode(header));
		chunks.push(
			typeof field.value === 'string' ? encoder.encode(field.value) : new Uint8Array(field.value),
		);
		chunks.push(encoder.encode('\r\n'));
	}
	chunks.push(encoder.encode(`--${boundary}--\r\n`));

	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return {
		contentType: `multipart/form-data; boundary=${boundary}`,
		body: body.buffer as ArrayBuffer,
	};
}
