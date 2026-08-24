import type { TokenProvider } from '../api/awork-client';
import type { OAuthClient, TokenSet } from './oauth-client';

/**
 * Holds the token set and hands valid access tokens to the API client.
 *
 * Refreshes are single-flighted: a sync fires many requests at once and a
 * rotating refresh token can only be redeemed once, so a stampede would
 * invalidate the session.
 */

export interface StoredAuth {
	clientId: string | null;
	tokens: TokenSet | null;
	/** Display only — shown in settings so you know which account is connected. */
	accountLabel: string | null;
}

export const emptyAuth: StoredAuth = { clientId: null, tokens: null, accountLabel: null };

export class NotConnectedError extends Error {
	constructor() {
		super('Not connected to awork. Open the plugin settings and choose "Connect to awork".');
		this.name = 'NotConnectedError';
	}
}

export class TokenStore implements TokenProvider {
	private inFlight: Promise<string> | null = null;

	constructor(
		private auth: StoredAuth,
		private readonly oauth: OAuthClient,
		private readonly persist: (auth: StoredAuth) => Promise<void>,
	) {}

	get snapshot(): StoredAuth {
		return this.auth;
	}

	get isConnected(): boolean {
		return this.auth.tokens !== null && this.auth.clientId !== null;
	}

	async setTokens(clientId: string, tokens: TokenSet, accountLabel: string | null): Promise<void> {
		this.auth = { clientId, tokens, accountLabel };
		await this.persist(this.auth);
	}

	async disconnect(): Promise<void> {
		// The client registration is kept: it is per-installation, not per-session,
		// and reusing it avoids piling up orphaned clients in the workspace.
		this.auth = { ...this.auth, tokens: null, accountLabel: null };
		await this.persist(this.auth);
	}

	async getAccessToken(): Promise<string> {
		const tokens = this.auth.tokens;
		if (!tokens || !this.auth.clientId) throw new NotConnectedError();
		if (Date.now() < tokens.expiresAt) return tokens.accessToken;
		return this.forceRefresh();
	}

	async forceRefresh(): Promise<string> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.doRefresh().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async doRefresh(): Promise<string> {
		const { clientId, tokens } = this.auth;
		if (!clientId || !tokens?.refreshToken) throw new NotConnectedError();
		const refreshed = await this.oauth.refresh(clientId, tokens.refreshToken);
		const next: TokenSet = {
			...refreshed,
			refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
		};
		this.auth = { ...this.auth, tokens: next };
		await this.persist(this.auth);
		return next.accessToken;
	}
}
