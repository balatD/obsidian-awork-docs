import { Notice, Plugin, type ObsidianProtocolData } from 'obsidian';
import { AworkClient } from './api/awork-client';
import { ThrottledTransport } from './api/http';
import { OAuthClient, REDIRECT_PATH } from './auth/oauth-client';
import { createPkcePair, randomState } from './auth/pkce';
import { NotConnectedError, TokenStore, type StoredAuth } from './auth/token-store';
import { migrateState } from './core/state';
import { metaFor, type SyncReport } from './core/sync-engine';
import {
	hashBody,
	isAworkExportHeader,
	joinFrontmatter,
	splitFrontmatter,
	stripAworkExportHeader,
} from './core/markdown';
import type { RemoteDoc } from './core/ports';
import { ObsidianTransport } from './obsidian/request-transport';
import { ObsidianVault } from './obsidian/vault-adapter';
import {
	AworkSyncSettingTab,
	DEFAULT_SETTINGS,
	mappingFrom,
	selectionFrom,
	type AworkSyncSettings,
} from './settings';
import { describeReport, runSync } from './sync-service';

const CLIENT_NAME = 'Obsidian awork Sync';

interface PendingAuthorization {
	state: string;
	verifier: string;
	clientId: string;
}

export default class AworkSyncPlugin extends Plugin {
	declare settings: AworkSyncSettings;
	tokens!: TokenStore;
	client!: AworkClient;

	private oauth!: OAuthClient;
	private pending: PendingAuthorization | null = null;
	private syncing = false;
	private statusBar: HTMLElement | null = null;
	private intervalId: number | null = null;
	private lastReport: SyncReport | null = null;

	override async onload(): Promise<void> {
		await this.loadSettings();

		const transport = ThrottledTransport.withConcurrency(
			new ObsidianTransport(),
			this.settings.concurrency,
		);
		this.oauth = new OAuthClient(transport);
		this.tokens = new TokenStore(this.settings.auth, this.oauth, async (auth) => {
			this.settings.auth = auth;
			await this.saveSettings();
		});
		this.client = new AworkClient(transport, this.tokens);

		this.registerObsidianProtocolHandler(REDIRECT_PATH, (params) => {
			void this.completeAuthorization(params);
		});

		this.addSettingTab(new AworkSyncSettingTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.updateStatusBar('idle');

		this.addRibbonIcon('refresh-cw', 'Sync awork docs', () => void this.syncNow());
		this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.syncNow() });
		this.addCommand({
			id: 'connect',
			name: 'Connect to awork',
			callback: () => void this.beginAuthorization(),
		});
		this.addCommand({
			id: 'normalize-notes',
			name: 'Clean up awork properties in synced notes',
			callback: () => {
				void this.normalizeNotes().then((count) =>
					new Notice(`Cleaned up ${count} notes.`),
				);
			},
		});
		this.addCommand({
			id: 'show-report',
			name: 'Show last sync report',
			callback: () => this.showLastReport(),
		});

		console.info('[awork-sync] loaded', {
			connected: this.tokens.isConnected,
			intervalMinutes: this.settings.intervalMinutes,
			syncOnStartup: this.settings.syncOnStartup,
		});

		this.rescheduleSync();
		if (this.settings.syncOnStartup && this.tokens.isConnected) {
			// Defer past workspace load so the vault index is populated.
			this.app.workspace.onLayoutReady(() => void this.syncNow(true));
		}
	}

	override onunload(): void {
		this.clearInterval();
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<AworkSyncSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(stored ?? {}),
			auth: { ...DEFAULT_SETTINGS.auth, ...(stored?.auth ?? {}) } as StoredAuth,
			state: migrateState(stored?.state),
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Rebuilds the HTTP stack after the concurrency setting changes. */
	rebuildClient(): void {
		const transport = ThrottledTransport.withConcurrency(
			new ObsidianTransport(),
			this.settings.concurrency,
		);
		this.oauth = new OAuthClient(transport);
		this.client = new AworkClient(transport, this.tokens);
	}

	rescheduleSync(): void {
		this.clearInterval();
		const minutes = this.settings.intervalMinutes;
		if (minutes <= 0) return;
		this.intervalId = window.setInterval(() => void this.syncNow(true), minutes * 60_000);
		this.registerInterval(this.intervalId);
	}

	async beginAuthorization(): Promise<void> {
		try {
			// The registration is per installation and survives disconnects.
			const clientId = this.settings.auth.clientId ?? (await this.oauth.registerClient(CLIENT_NAME));
			if (clientId !== this.settings.auth.clientId) {
				this.settings.auth = { ...this.settings.auth, clientId };
				await this.saveSettings();
			}

			const { verifier, challenge } = await createPkcePair();
			const state = randomState();
			this.pending = { state, verifier, clientId };
			window.open(this.oauth.buildAuthorizeUrl(clientId, challenge, state));
			new Notice('Finish the awork login in your browser.');
		} catch (error) {
			new Notice(`awork: could not start authorization — ${messageOf(error)}`, 10_000);
		}
	}

	async disconnect(): Promise<void> {
		await this.tokens.disconnect();
		new Notice('Disconnected from awork. Your notes were left untouched.');
	}

	private async completeAuthorization(params: ObsidianProtocolData): Promise<void> {
		const pending = this.pending;
		this.pending = null;

		if (params.error) {
			new Notice(`awork denied the authorization: ${params.error}`, 10_000);
			return;
		}
		if (!pending || params.state !== pending.state) {
			// Either a stale callback or a forged one; neither should be redeemed.
			new Notice('awork: ignored an unexpected authorization callback.', 10_000);
			return;
		}
		if (!params.code) {
			new Notice('awork: the authorization callback carried no code.', 10_000);
			return;
		}

		try {
			const tokens = await this.oauth.exchangeCode(pending.clientId, params.code, pending.verifier);
			await this.tokens.setTokens(pending.clientId, tokens, null);
			const user = await this.client.getCurrentUser();
			const label = [user.firstName, user.lastName].filter(Boolean).join(' ') || (user.email ?? user.id);
			await this.tokens.setTokens(pending.clientId, tokens, label);
			this.settings.auth = this.tokens.snapshot;
			await this.saveSettings();
			new Notice(`Connected to awork as ${label}.`);
		} catch (error) {
			new Notice(`awork: token exchange failed — ${messageOf(error)}`, 10_000);
		}
	}

	async syncNow(silent = false): Promise<void> {
		if (this.syncing) {
			console.info('[awork-sync] skipped: a sync is already running');
			if (!silent) new Notice('awork sync is already running.');
			return;
		}
		if (!this.tokens.isConnected) {
			console.warn('[awork-sync] skipped: not connected', {
				hasClientId: this.settings.auth.clientId !== null,
				hasTokens: this.settings.auth.tokens !== null,
			});
			if (!silent) new Notice('Connect to awork first (plugin settings).');
			return;
		}

		console.info('[awork-sync] starting sync', {
			trigger: silent ? 'automatic' : 'manual',
			spaces: this.settings.spaceIds.length,
			includePrivate: this.settings.includePrivate,
			includeShared: this.settings.includeShared,
			syncRoot: this.settings.syncRoot,
		});
		this.syncing = true;
		this.updateStatusBar('syncing');
		try {
			const mapping = mappingFrom(this.settings);
			const report = await runSync({
				remote: this.client,
				vault: new ObsidianVault(this.app, mapping),
				mapping,
				selection: selectionFrom(this.settings),
				deletionPolicy: this.settings.deletionPolicy,
				frontmatter: this.settings.frontmatter,
				concurrency: this.settings.concurrency,
				loadState: () => this.settings.state,
				saveState: async (state) => {
					this.settings.state = state;
					await this.saveSettings();
				},
				onProgress: (done, total) => this.updateStatusBar('syncing', `${done}/${total}`),
			});
			this.lastReport = report;
			this.updateStatusBar('idle');
			console.info('[awork-sync] finished', report);

			if (report.errors.length > 0) {
				new Notice(`awork sync: ${describeReport(report)}. Run "Show last sync report" for details.`, 10_000);
			} else if (!silent) {
				new Notice(`awork sync: ${describeReport(report)}.`);
			}
		} catch (error) {
			this.updateStatusBar('error');
			console.error('[awork-sync] sync failed', error);
			const message =
				error instanceof NotConnectedError
					? error.message
					: `awork sync failed — ${messageOf(error)}`;
			new Notice(message, 10_000);
		} finally {
			this.syncing = false;
		}
	}

	/**
	 * Applies the current property style to every tracked note and removes any
	 * leftover awork export header, without syncing.
	 *
	 * The recorded hash is realigned as it goes: the export header was never real
	 * content, so cleaning it up must not read as a local edit on the next pass.
	 */
	async normalizeNotes(): Promise<number> {
		const mapping = mappingFrom(this.settings);
		const vault = new ObsidianVault(this.app, mapping);
		const docs = { ...this.settings.state.docs };
		let touched = 0;

		for (const record of Object.values(docs)) {
			if (!(await vault.exists(record.path))) continue;
			const raw = await vault.read(record.path);
			const split = splitFrontmatter(raw);

			// With no properties of our own on the note, the block we just split
			// off may be awork's export header rather than the note's frontmatter.
			const headerOnly = isAworkExportHeader(split.frontmatter);
			const ownFrontmatter = headerOnly ? null : split.frontmatter;
			const body = headerOnly
				? split.body.replace(/^\n+/, '')
				: stripAworkExportHeader(split.body);

			const doc: RemoteDoc = {
				id: record.id,
				name: record.name,
				scope: record.scope,
				spaceId: record.spaceId,
				parentId: record.parentId,
				updatedOn: record.remoteUpdatedOn,
				emoji: null,
			};
			const rewritten = joinFrontmatter(
				metaFor(ownFrontmatter, doc, this.settings.frontmatter),
				body,
			);
			if (rewritten === raw) continue;

			await vault.write(record.path, rewritten);
			docs[record.id] = { ...record, bodyHash: await hashBody(body) };
			touched++;
		}

		this.settings.state = { ...this.settings.state, docs };
		await this.saveSettings();
		return touched;
	}

	private showLastReport(): void {
		const report = this.lastReport;
		if (!report) {
			new Notice('No awork sync has run yet in this session.');
			return;
		}
		const lines = [describeReport(report)];
		for (const failure of report.errors.slice(0, 10)) {
			lines.push(`• ${failure.action} ${failure.target}: ${failure.message}`);
		}
		if (report.errors.length > 10) lines.push(`…and ${report.errors.length - 10} more.`);
		new Notice(lines.join('\n'), 15_000);
	}

	private updateStatusBar(phase: 'idle' | 'syncing' | 'error', detail?: string): void {
		if (!this.statusBar) return;
		if (phase === 'syncing') {
			this.statusBar.setText(detail ? `awork: syncing ${detail}` : 'awork: syncing…');
			return;
		}
		if (phase === 'error') {
			this.statusBar.setText('awork: sync failed');
			return;
		}
		const last = this.settings.state.lastSyncAt;
		this.statusBar.setText(last ? `awork: synced ${formatTime(last)}` : 'awork: never synced');
	}

	private clearInterval(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}
}

function formatTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? 'recently'
		: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
