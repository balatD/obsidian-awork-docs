/**
 * CLI companion to the plugin's connect flow.
 *
 * Runs the same dynamic-registration + PKCE dance, but with a loopback redirect
 * so it works outside Obsidian. Tokens land in `.awork-cli-tokens.json` for the
 * other scripts to pick up. Useful for checking markdown fidelity against a real
 * workspace before touching a vault.
 *
 *   npm run -s connect
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { FetchTransport } from '../src/api/fetch-transport';
import { OAuthClient, AWORK_ENDPOINTS } from '../src/auth/oauth-client';
import { createPkcePair, randomState } from '../src/auth/pkce';
import { TOKEN_FILE } from './token-file';

const PORT = 42813;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

async function main(): Promise<void> {
	const oauth = new OAuthClient(new FetchTransport(), AWORK_ENDPOINTS, REDIRECT_URI);

	console.log('Registering a public client with awork…');
	const clientId = await oauth.registerClient('awork Obsidian sync (CLI)');
	console.log(`  client_id: ${clientId}`);

	const { verifier, challenge } = await createPkcePair();
	const state = randomState();
	const authorizeUrl = oauth.buildAuthorizeUrl(clientId, challenge, state);

	const code = await waitForCode(authorizeUrl, state);
	const tokens = await oauth.exchangeCode(clientId, code, verifier);

	writeFileSync(TOKEN_FILE, JSON.stringify({ clientId, ...tokens }, null, 2));
	console.log(`\nConnected. Tokens written to ${TOKEN_FILE} (gitignored).`);
	console.log('Now try:  npm run -s roundtrip -- --list');
}

function waitForCode(authorizeUrl: string, expectedState: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
			if (url.pathname !== '/callback') {
				response.writeHead(404).end();
				return;
			}

			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');
			const error = url.searchParams.get('error');

			const ok = !error && Boolean(code) && state === expectedState;
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			response.end(
				`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:3rem">` +
					`<h1>${ok ? 'Connected' : 'Something went wrong'}</h1>` +
					`<p>You can close this tab and return to the terminal.</p>`,
			);
			server.close();

			if (error) reject(new Error(`awork returned an error: ${error}`));
			else if (state !== expectedState) reject(new Error('state mismatch — ignoring the callback'));
			else if (!code) reject(new Error('no authorization code in the callback'));
			else resolve(code);
		});

		server.listen(PORT, '127.0.0.1', () => {
			console.log(`\nListening on ${REDIRECT_URI}`);
			console.log('Opening your browser. If it does not open, visit:\n');
			console.log(authorizeUrl, '\n');
			openBrowser(authorizeUrl);
		});
		server.on('error', reject);
	});
}

function openBrowser(url: string): void {
	const command =
		process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
	spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
