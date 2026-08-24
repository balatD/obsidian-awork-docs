/**
 * Diagnostics for when a sync misbehaves. Silent unless switched on in
 * settings — an always-on console is noise in a shared devtools panel, and
 * Obsidian's review guidelines call it out.
 */
export class Logger {
	constructor(private enabled: () => boolean) {}

	info(message: string, detail?: unknown): void {
		if (this.enabled()) console.info(`[awork-docs] ${message}`, detail ?? '');
	}

	warn(message: string, detail?: unknown): void {
		if (this.enabled()) console.warn(`[awork-docs] ${message}`, detail ?? '');
	}

	/** Failures are always reported: they are why someone opens the console. */
	error(message: string, detail?: unknown): void {
		console.error(`[awork-docs] ${message}`, detail ?? '');
	}
}
