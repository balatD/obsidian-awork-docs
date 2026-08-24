import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import { isExcluded, isUnder, type MappingOptions } from '../core/mapping';
import type { LocalFile, LocalVault } from '../core/ports';

/**
 * `LocalVault` over Obsidian's vault API.
 *
 * Uses the high-level API rather than the filesystem adapter so that Obsidian's
 * own index, link updating and trash behaviour stay correct — in particular
 * `fileManager.renameFile`, which rewrites inbound links when a note moves.
 */
export class ObsidianVault implements LocalVault {
	constructor(
		private readonly app: App,
		private readonly mapping: MappingOptions,
	) {}

	async list(root: string): Promise<LocalFile[]> {
		const normalizedRoot = normalizePath(root);
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => isUnder(file.path, normalizedRoot) && !isExcluded(file.path, this.mapping))
			.map((file) => ({ path: file.path, mtime: file.stat.mtime }));
	}

	async read(path: string): Promise<string> {
		return this.app.vault.read(this.requireFile(path));
	}

	/** Cheap read for the scan pass; served from Obsidian's cache when warm. */
	async readCached(path: string): Promise<string> {
		return this.app.vault.cachedRead(this.requireFile(path));
	}

	async write(path: string, content: string): Promise<void> {
		const normalized = normalizePath(path);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
			return;
		}
		await this.ensureFolder(parentOf(normalized));
		await this.app.vault.create(normalized, content);
	}

	async writeBinary(path: string, bytes: ArrayBuffer): Promise<void> {
		const normalized = normalizePath(path);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, bytes);
			return;
		}
		await this.ensureFolder(parentOf(normalized));
		await this.app.vault.createBinary(normalized, bytes);
	}

	async rename(from: string, to: string): Promise<void> {
		const file = this.requireFile(from);
		const target = normalizePath(to);
		await this.ensureFolder(parentOf(target));
		// Destination occupied (name collision after a remote rename): step aside
		// rather than clobbering whatever is already there.
		const free = (await this.exists(target)) ? await this.freePath(target) : target;
		await this.app.fileManager.renameFile(file, free);
	}

	async trash(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (file instanceof TFile) await this.app.vault.trash(file, true);
	}

	async exists(path: string): Promise<boolean> {
		return this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile;
	}

	private requireFile(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) throw new Error(`No such note in the vault: ${path}`);
		return file;
	}

	private async ensureFolder(path: string): Promise<void> {
		if (path === '') return;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) return;
		await this.ensureFolder(parentOf(path));
		try {
			await this.app.vault.createFolder(path);
		} catch (error) {
			// Concurrent creates race here; only a genuine failure should surface.
			if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw error;
		}
	}

	private async freePath(path: string): Promise<string> {
		const stem = path.replace(/\.md$/, '');
		for (let suffix = 2; ; suffix++) {
			const candidate = `${stem} (${suffix}).md`;
			if (!(await this.exists(candidate))) return candidate;
		}
	}
}

function parentOf(path: string): string {
	const index = path.lastIndexOf('/');
	return index === -1 ? '' : path.slice(0, index);
}
