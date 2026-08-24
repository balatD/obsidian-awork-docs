/**
 * PKCE helpers (RFC 7636). awork advertises only `S256` in its discovery
 * document, so no `plain` fallback is offered here.
 */

export interface PkcePair {
	verifier: string;
	challenge: string;
}

export async function createPkcePair(): Promise<PkcePair> {
	const verifier = base64url(randomBytes(32));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Ties the callback back to the request that started it (CSRF guard). */
export function randomState(): string {
	return base64url(randomBytes(16));
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
