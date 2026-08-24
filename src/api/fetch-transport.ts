import type { HttpRequest, HttpResponse, HttpTransport } from './http';

/** Transport for the CLI scripts and tests, where `requestUrl` does not exist. */
export class FetchTransport implements HttpTransport {
	async send(request: HttpRequest): Promise<HttpResponse> {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body as BodyInit | undefined,
		});
		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});
		return { status: response.status, headers, text: await response.text() };
	}
}
