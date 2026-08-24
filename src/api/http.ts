/**
 * Transport seam: the plugin runs on Obsidian's `requestUrl` (which bypasses
 * CORS), while the CLI scripts and tests run on plain `fetch`. Everything above
 * this file is transport-agnostic.
 */

export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

export interface HttpTransport {
	send(request: HttpRequest): Promise<HttpResponse>;
}

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly method: string,
		readonly url: string,
		readonly body: string,
	) {
		super(`${method} ${stripQuery(url)} failed with ${status}: ${truncate(body, 300)}`);
		this.name = 'HttpError';
	}

	/** 401/403 mean the token is stale or the doc is no longer readable. */
	get isAuthFailure(): boolean {
		return this.status === 401 || this.status === 403;
	}

	get isNotFound(): boolean {
		return this.status === 404;
	}
}

export interface RateLimitOptions {
	/** Simultaneous in-flight requests. awork allows 50/s workspace-wide. */
	concurrency: number;
	maxRetries: number;
	/** Base for exponential backoff when the API gives us no reset hint. */
	baseRetryDelayMs: number;
	sleep: (ms: number) => Promise<void>;
}

/**
 * awork allows 50 requests/second and 1000/minute per workspace, shared with
 * every other integration. Four in flight against ~100ms round trips lands near
 * 40/s, which is brisk without crowding out anything else.
 */
export const DEFAULT_CONCURRENCY = 4;

export const defaultRateLimitOptions: RateLimitOptions = {
	concurrency: DEFAULT_CONCURRENCY,
	maxRetries: 4,
	baseRetryDelayMs: 1000,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Serializes requests to a fixed concurrency and retries 429/5xx with backoff.
 * The rate limit is shared by every integration on the workspace, so the
 * `ratelimit-reset` hint is honoured before falling back to exponential delay.
 */
export class ThrottledTransport implements HttpTransport {
	private active = 0;
	private readonly queue: Array<() => void> = [];

	constructor(
		private readonly inner: HttpTransport,
		private readonly options: RateLimitOptions = defaultRateLimitOptions,
	) {}

	static withConcurrency(inner: HttpTransport, concurrency: number): ThrottledTransport {
		return new ThrottledTransport(inner, { ...defaultRateLimitOptions, concurrency });
	}

	async send(request: HttpRequest): Promise<HttpResponse> {
		await this.acquire();
		try {
			return await this.sendWithRetry(request);
		} finally {
			this.release();
		}
	}

	private async sendWithRetry(request: HttpRequest): Promise<HttpResponse> {
		let attempt = 0;
		for (;;) {
			const response = await this.inner.send(request);
			const retryable = response.status === 429 || response.status >= 500;
			if (!retryable || attempt >= this.options.maxRetries) return response;
			await this.options.sleep(this.retryDelay(response, attempt));
			attempt++;
		}
	}

	private retryDelay(response: HttpResponse, attempt: number): number {
		const hint =
			response.headers['retry-after'] ??
			response.headers['ratelimit-reset'] ??
			response.headers['x-ratelimit-reset'];
		const seconds = hint === undefined ? NaN : Number(hint);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000 + 250, 60_000);
		return Math.min(this.options.baseRetryDelayMs * 2 ** attempt, 30_000);
	}

	private acquire(): Promise<void> {
		if (this.active < this.options.concurrency) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.queue.push(() => {
				this.active++;
				resolve();
			});
		});
	}

	private release(): void {
		this.active--;
		this.queue.shift()?.();
	}
}

export function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) result[key.toLowerCase()] = value;
	return result;
}

function stripQuery(url: string): string {
	const index = url.indexOf('?');
	return index === -1 ? url : url.slice(0, index);
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}
