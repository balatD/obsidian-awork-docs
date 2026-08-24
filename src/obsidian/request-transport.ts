import { requestUrl } from 'obsidian';
import type { HttpRequest, HttpResponse, HttpTransport } from '../api/http';
import { lowercaseHeaders } from '../api/http';

/**
 * Obsidian's `requestUrl` issues requests from the app process rather than the
 * renderer, which is what lets the plugin talk to api.awork.com without CORS
 * preflight failures. `throw: false` keeps error statuses as data so the
 * throttling layer can inspect 429s.
 */
export class ObsidianTransport implements HttpTransport {
	async send(request: HttpRequest): Promise<HttpResponse> {
		const response = await requestUrl({
			url: request.url,
			method: request.method,
			headers: request.headers,
			body: request.body,
			throw: false,
		});
		return {
			status: response.status,
			headers: lowercaseHeaders(response.headers ?? {}),
			text: response.text ?? '',
			bytes: response.arrayBuffer,
		};
	}
}
