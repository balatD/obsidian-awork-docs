import { AWORK_API_BASE } from '../api/types';
import { HttpError, type HttpTransport } from '../api/http';

/**
 * OAuth 2.1 authorization-code + PKCE against awork.
 *
 * awork implements RFC 7591 dynamic client registration on an unauthenticated
 * endpoint and accepts a custom `obsidian://` redirect URI, so the plugin
 * registers its own public client on first connect — the user never has to be a
 * workspace admin or paste a client id.
 */

export const REDIRECT_PATH = 'awork-docs-callback';
export const REDIRECT_URI = `obsidian://${REDIRECT_PATH}`;
export const SCOPE = 'full_access offline_access';

export interface OAuthEndpoints {
	authorization: string;
	token: string;
	registration: string;
}

export const AWORK_ENDPOINTS: OAuthEndpoints = {
	authorization: `${AWORK_API_BASE}/accounts/authorize`,
	token: `${AWORK_API_BASE}/accounts/token`,
	registration: `${AWORK_API_BASE}/clientapplications/register`,
};

export interface TokenSet {
	accessToken: string;
	refreshToken: string | null;
	/** Epoch millis. */
	expiresAt: number;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	token_type?: string;
}

/** Access tokens are refreshed this early to avoid racing their expiry. */
const EXPIRY_SKEW_MS = 60_000;

export class OAuthClient {
	constructor(
		private readonly transport: HttpTransport,
		private readonly endpoints: OAuthEndpoints = AWORK_ENDPOINTS,
		private readonly redirectUri: string = REDIRECT_URI,
	) {}

	/** Registers a public client (no secret, `token_endpoint_auth_method: none`). */
	async registerClient(clientName: string): Promise<string> {
		const response = await this.transport.send({
			method: 'POST',
			url: this.endpoints.registration,
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({
				client_name: clientName,
				redirect_uris: [this.redirectUri],
				token_endpoint_auth_method: 'none',
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				application_type: 'native',
				scope: SCOPE,
			}),
		});
		if (response.status >= 400) {
			throw new HttpError(response.status, 'POST', this.endpoints.registration, response.text);
		}
		const registration = JSON.parse(response.text) as { client_id?: string };
		if (!registration.client_id) throw new Error('awork returned no client_id during registration');
		return registration.client_id;
	}

	buildAuthorizeUrl(clientId: string, challenge: string, state: string): string {
		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: this.redirectUri,
			response_type: 'code',
			scope: SCOPE,
			state,
			code_challenge: challenge,
			code_challenge_method: 'S256',
		});
		return `${this.endpoints.authorization}?${params.toString()}`;
	}

	async exchangeCode(clientId: string, code: string, verifier: string): Promise<TokenSet> {
		return this.token({
			grant_type: 'authorization_code',
			code,
			redirect_uri: this.redirectUri,
			client_id: clientId,
			code_verifier: verifier,
		});
	}

	async refresh(clientId: string, refreshToken: string): Promise<TokenSet> {
		return this.token({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: clientId,
		});
	}

	private async token(fields: Record<string, string>): Promise<TokenSet> {
		const response = await this.transport.send({
			method: 'POST',
			url: this.endpoints.token,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json',
			},
			body: new URLSearchParams(fields).toString(),
		});
		if (response.status >= 400) {
			throw new HttpError(response.status, 'POST', this.endpoints.token, response.text);
		}
		const payload = JSON.parse(response.text) as TokenResponse;
		if (!payload.access_token) throw new Error('awork returned no access_token');
		return {
			accessToken: payload.access_token,
			// Refresh tokens rotate on use; keep the old one if none came back.
			refreshToken: payload.refresh_token ?? null,
			expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000 - EXPIRY_SKEW_MS,
		};
	}
}
