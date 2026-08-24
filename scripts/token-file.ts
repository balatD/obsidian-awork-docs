import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { TokenProvider } from '../src/api/awork-client';
import { OAuthClient, AWORK_ENDPOINTS } from '../src/auth/oauth-client';
import { FetchTransport } from '../src/api/fetch-transport';
import type { TokenSet } from '../src/auth/oauth-client';

export const TOKEN_FILE = '.awork-cli-tokens.json';

interface StoredCliTokens extends TokenSet {
	clientId: string;
}

/**
 * Token provider for the CLI scripts, backed by the file `connect.ts` writes.
 * Also accepts `AWORK_TOKEN` so an API key can be used instead of a login.
 */
export class CliTokens implements TokenProvider {
	private stored: StoredCliTokens | null;

	constructor(private readonly apiKey: string | undefined = process.env.AWORK_TOKEN) {
		this.stored = existsSync(TOKEN_FILE)
			? (JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as StoredCliTokens)
			: null;
		if (!this.apiKey && !this.stored) {
			throw new Error(
				`Not connected. Run "npm run -s connect" first, or set AWORK_TOKEN to an awork API key.`,
			);
		}
	}

	async getAccessToken(): Promise<string> {
		if (this.apiKey) return this.apiKey;
		const stored = this.stored as StoredCliTokens;
		if (Date.now() >= stored.expiresAt) return this.forceRefresh();
		return stored.accessToken;
	}

	async forceRefresh(): Promise<string> {
		if (this.apiKey) return this.apiKey;
		const stored = this.stored as StoredCliTokens;
		if (!stored.refreshToken) throw new Error('No refresh token; run "npm run -s connect" again.');

		const oauth = new OAuthClient(new FetchTransport(), AWORK_ENDPOINTS, `http://127.0.0.1:42813/callback`);
		const refreshed = await oauth.refresh(stored.clientId, stored.refreshToken);
		this.stored = {
			clientId: stored.clientId,
			...refreshed,
			refreshToken: refreshed.refreshToken ?? stored.refreshToken,
		};
		writeFileSync(TOKEN_FILE, JSON.stringify(this.stored, null, 2));
		return this.stored.accessToken;
	}
}
