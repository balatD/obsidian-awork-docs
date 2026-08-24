import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { MappingOptions, NestingStyle } from './core/mapping';
import type { DeletionPolicy } from './core/plan';
import type { DocSelection, RemoteSpace } from './core/ports';
import { emptyState, type SyncState } from './core/state';
import type { FrontmatterMode } from './core/sync-engine';
import { DEFAULT_CONCURRENCY } from './api/http';
import { emptyAuth, type StoredAuth } from './auth/token-store';
import type AworkSyncPlugin from './main';

export interface AworkSyncSettings {
	syncRoot: string;
	privateFolder: string;
	sharedFolder: string;
	spaceIds: string[];
	includePrivate: boolean;
	includeShared: boolean;
	deletionPolicy: DeletionPolicy;
	/** Where a document with children keeps its own note. */
	nesting: NestingStyle;
	/** How much awork bookkeeping to leave in each note's properties. */
	frontmatter: FrontmatterMode;
	/** Documents worked on at once. See the note in the settings tab. */
	concurrency: number;
	/** Minutes between automatic syncs; 0 disables the timer. */
	intervalMinutes: number;
	syncOnStartup: boolean;
	auth: StoredAuth;
	state: SyncState;
}

export const DEFAULT_SETTINGS: AworkSyncSettings = {
	syncRoot: 'awork',
	privateFolder: 'Private',
	sharedFolder: 'Shared with me',
	spaceIds: [],
	includePrivate: true,
	includeShared: true,
	deletionPolicy: 'ignore',
	nesting: 'inside',
	frontmatter: 'minimal',
	concurrency: DEFAULT_CONCURRENCY,
	intervalMinutes: 5,
	syncOnStartup: false,
	auth: emptyAuth,
	state: emptyState(),
};

export function mappingFrom(settings: AworkSyncSettings): MappingOptions {
	return {
		syncRoot: settings.syncRoot.replace(/^\/+|\/+$/g, '') || 'awork',
		privateFolder: settings.privateFolder || 'Private',
		sharedFolder: settings.sharedFolder || 'Shared with me',
		nesting: settings.nesting,
	};
}

export function selectionFrom(settings: AworkSyncSettings): DocSelection {
	return {
		spaceIds: settings.spaceIds,
		includePrivate: settings.includePrivate,
		includeShared: settings.includeShared,
	};
}

export class AworkSyncSettingTab extends PluginSettingTab {
	private spaces: RemoteSpace[] = [];
	private spacesError: string | null = null;
	/** Distinguishes "not fetched yet" from "fetched, and there are none". */
	private spacesLoaded = false;

	constructor(
		app: App,
		private readonly plugin: AworkSyncPlugin,
	) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderConnection(containerEl);
		if (this.plugin.tokens.isConnected) {
			this.renderScope(containerEl);
			this.renderFolders(containerEl);
			this.renderBehaviour(containerEl);
			this.renderMaintenance(containerEl);
		}
	}

	private renderConnection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Connection').setHeading();

		const auth = this.plugin.settings.auth;
		const connected = this.plugin.tokens.isConnected;

		new Setting(containerEl)
			.setName('awork account')
			.setDesc(
				connected
					? `Connected as ${auth.accountLabel ?? 'unknown user'}.`
					: 'Not connected. Authorization opens in your browser and returns to Obsidian.',
			)
			.addButton((button) =>
				button
					.setButtonText(connected ? 'Disconnect' : 'Connect to awork')
					.setCta()
					.onClick(async () => {
						if (connected) {
							await this.plugin.disconnect();
						} else {
							await this.plugin.beginAuthorization();
						}
						this.display();
					}),
			);

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Access and refresh tokens are stored in this plugin\'s data.json inside the vault, in plain text. ' +
				'If you sync the vault elsewhere, exclude .obsidian/plugins/awork-sync/data.json.',
		});
	}

	private renderScope(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('What to sync').setHeading();

		new Setting(containerEl)
			.setName('My private docs')
			.setDesc('Documents only you can see.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.includePrivate).onChange(async (value) => {
					this.plugin.settings.includePrivate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Shared with me')
			.setDesc('Documents others shared with you directly. New notes cannot be created here.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.includeShared).onChange(async (value) => {
					this.plugin.settings.includeShared = value;
					await this.plugin.saveSettings();
				}),
			);

		const spacesSetting = new Setting(containerEl)
			.setName('Document spaces')
			.setDesc('Pick the spaces to mirror into the vault.')
			.addButton((button) =>
				button.setButtonText('Reload spaces').onClick(async () => {
					this.spacesLoaded = false;
					await this.loadSpaces();
					this.display();
				}),
			);

		if (this.spacesError) {
			spacesSetting.descEl.createEl('div', { text: this.spacesError, cls: 'mod-warning' });
			return;
		}

		if (!this.spacesLoaded) {
			// Lazily fetch on first open so the tab renders immediately.
			void this.loadSpaces().then(() => this.display());
			spacesSetting.descEl.createEl('div', { text: 'Loading spaces…' });
			return;
		}

		if (this.spaces.length === 0) {
			spacesSetting.descEl.createEl('div', { text: 'This workspace has no document spaces.' });
			return;
		}

		for (const space of this.spaces) {
			new Setting(containerEl).setName(space.name).addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.spaceIds.includes(space.id)).onChange(async (value) => {
					const selected = new Set(this.plugin.settings.spaceIds);
					if (value) selected.add(space.id);
					else selected.delete(space.id);
					this.plugin.settings.spaceIds = [...selected];
					await this.plugin.saveSettings();
				}),
			);
		}
	}

	private renderFolders(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Where to put it').setHeading();

		new Setting(containerEl)
			.setName('Sync folder')
			.setDesc('Vault folder that mirrors awork. Everything below it is managed by this plugin.')
			.addText((text) =>
				text.setValue(this.plugin.settings.syncRoot).onChange(async (value) => {
					this.plugin.settings.syncRoot = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName('Private docs subfolder').addText((text) =>
			text.setValue(this.plugin.settings.privateFolder).onChange(async (value) => {
				this.plugin.settings.privateFolder = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl).setName('Shared docs subfolder').addText((text) =>
			text.setValue(this.plugin.settings.sharedFolder).onChange(async (value) => {
				this.plugin.settings.sharedFolder = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName('Documents that contain other documents')
			.setDesc(
				'awork lets a document hold child documents. Obsidian sorts every folder above ' +
					'every file, so keeping the parent inside its own folder is the only way it stays ' +
					'next to its children. Works with the Folder Notes plugin.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('inside', 'Inside its folder — Kunden/Kunden.md')
					.addOption('sibling', 'Next to its folder — Kunden.md')
					.setValue(this.plugin.settings.nesting)
					.onChange(async (value) => {
						this.plugin.settings.nesting = value as NestingStyle;
						await this.plugin.saveSettings();
						new Notice('Parent notes move to their new place on the next sync.');
					}),
			);
	}

	private renderBehaviour(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Behaviour').setHeading();

		new Setting(containerEl)
			.setName('awork properties in notes')
			.setDesc(
				'None keeps your notes completely clean — documents are then matched by their ' +
					'location, so moving a note while the plugin is off can orphan it. ' +
					'None of these lines are ever sent to awork.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('minimal', 'Just the id')
					.addOption('full', 'Id, last change and link')
					.addOption('none', 'None')
					.setValue(this.plugin.settings.frontmatter)
					.onChange(async (value) => {
						this.plugin.settings.frontmatter = value as FrontmatterMode;
						await this.plugin.saveSettings();
						// Rewrite immediately so the choice is visible without a sync.
						const touched = await this.plugin.normalizeNotes();
						new Notice(`Updated awork properties in ${touched} notes.`);
					}),
			);

		new Setting(containerEl)
			.setName('Sync automatically')
			.setDesc('Minutes between syncs. awork has no document webhooks, so this polls. 0 turns it off.')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.intervalMinutes))
					.onChange(async (value) => {
						const minutes = Number(value);
						if (!Number.isFinite(minutes) || minutes < 0) return;
						this.plugin.settings.intervalMinutes = Math.floor(minutes);
						await this.plugin.saveSettings();
						this.plugin.rescheduleSync();
					}),
			);

		new Setting(containerEl).setName('Sync on startup').addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
				this.plugin.settings.syncOnStartup = value;
				await this.plugin.saveSettings();
			}),
		);

		new Setting(containerEl)
			.setName('Documents at once')
			.setDesc(
				'Higher is not faster: measured on 64 documents, 4 took ~3s and 1 took ~8s, ' +
					'but 8 was slower again and 16 ran into awork\'s rate limit. Leave at 4 unless ' +
					'you have a reason.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(1, 8, 1)
					.setValue(this.plugin.settings.concurrency)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.concurrency = value;
						await this.plugin.saveSettings();
						this.plugin.rebuildClient();
					}),
			);

		new Setting(containerEl)
			.setName('When a synced note is deleted here')
			.setDesc('Mirroring moves the awork document to the workspace trash. Otherwise it is downloaded again.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('ignore', 'Restore it from awork')
					.addOption('mirror', 'Move it to the awork trash')
					.setValue(this.plugin.settings.deletionPolicy)
					.onChange(async (value) => {
						this.plugin.settings.deletionPolicy = value as DeletionPolicy;
						await this.plugin.saveSettings();
					}),
			);
	}

	private renderMaintenance(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Maintenance').setHeading();

		const last = this.plugin.settings.state.lastSyncAt;
		new Setting(containerEl)
			.setName('Reset sync state')
			.setDesc(
				`Forgets what was synced (last run: ${last ?? 'never'}) without touching any note. ` +
					'The next sync re-adopts notes by their awork-id and resolves differences newest-first.',
			)
			.addButton((button) =>
				button.setWarning().setButtonText('Reset').onClick(async () => {
					this.plugin.settings.state = emptyState();
					await this.plugin.saveSettings();
					new Notice('awork sync state reset.');
					this.display();
				}),
			);
	}

	private async loadSpaces(): Promise<void> {
		try {
			this.spaces = await this.plugin.client.listSpaces();
			this.spacesError = null;
		} catch (error) {
			this.spaces = [];
			this.spacesError = error instanceof Error ? error.message : String(error);
		} finally {
			this.spacesLoaded = true;
		}
	}
}
