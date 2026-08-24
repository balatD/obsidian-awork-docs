import { describe, expect, it } from 'vitest';
import { AworkClient } from '../src/api/awork-client';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/api/http';

class StubTransport implements HttpTransport {
	readonly sent: HttpRequest[] = [];
	constructor(private readonly reply: (request: HttpRequest) => HttpResponse) {}
	async send(request: HttpRequest): Promise<HttpResponse> {
		this.sent.push(request);
		return this.reply(request);
	}
}

const tokens = {
	getAccessToken: async () => 'token',
	forceRefresh: async () => 'token',
};

function ok(body: unknown): HttpResponse {
	return { status: 200, headers: {}, text: JSON.stringify(body) };
}

describe('AworkClient.getMarkdown', () => {
	it('strips the name header awork adds to every export', async () => {
		const transport = new StubTransport(() =>
			ok({ id: 'doc-a', content: '---\nname: Runbook\n---\n\n# Runbook\n\nStep one.' }),
		);
		const client = new AworkClient(transport, tokens);

		expect(await client.getMarkdown('doc-a')).toBe('# Runbook\n\nStep one.');
	});

	it('leaves a document that genuinely starts with properties alone', async () => {
		const content = '---\nname: Runbook\ntags: [ops]\n---\n\nbody';
		const client = new AworkClient(new StubTransport(() => ok({ id: 'doc-a', content })), tokens);

		expect(await client.getMarkdown('doc-a')).toBe(content);
	});

	it('asks for markdown rather than html', async () => {
		const transport = new StubTransport(() => ok({ id: 'doc-a', content: 'body' }));
		await new AworkClient(transport, tokens).getMarkdown('doc-a');

		expect(transport.sent[0]?.url).toContain('format=markdown');
	});

	it('refreshes once and retries after a 401', async () => {
		let calls = 0;
		const transport = new StubTransport(() => {
			calls++;
			return calls === 1
				? { status: 401, headers: {}, text: 'expired' }
				: ok({ id: 'doc-a', content: 'body' });
		});
		let refreshed = false;
		const client = new AworkClient(transport, {
			getAccessToken: async () => 'stale',
			forceRefresh: async () => {
				refreshed = true;
				return 'fresh';
			},
		});

		expect(await client.getMarkdown('doc-a')).toBe('body');
		expect(refreshed).toBe(true);
		expect(transport.sent[1]?.headers?.Authorization).toBe('Bearer fresh');
	});

	it('sends content as multipart markdown, not JSON', async () => {
		const transport = new StubTransport(() =>
			ok({ id: 'doc-a', name: 'Runbook', updatedOn: '2026-08-24T10:00:00Z' }),
		);
		await new AworkClient(transport, tokens).putMarkdown('doc-a', '# Body');

		const request = transport.sent[0];
		expect(request?.headers?.['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
		const body = new TextDecoder().decode(request?.body as ArrayBuffer);
		expect(body).toContain('name="contentFormat"');
		expect(body).toContain('markdown');
		expect(body).toContain('# Body');
	});
});
