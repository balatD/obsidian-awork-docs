/**
 * Keeps manifest.json and versions.json in step with package.json.
 *
 * Obsidian's plugin directory requires the release tag to equal the manifest
 * version exactly, and versions.json to map every published version to the
 * minimum app version it needs. Run via `npm version <patch|minor|major>`,
 * which invokes this and stages the result.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const target = process.env.npm_package_version;
if (!target) {
	console.error('Run this through `npm version`, not directly.');
	process.exit(1);
}

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
manifest.version = target;
writeFileSync('manifest.json', `${JSON.stringify(manifest, null, '\t')}\n`);

const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[target] = manifest.minAppVersion;
writeFileSync('versions.json', `${JSON.stringify(versions, null, '\t')}\n`);

console.log(`manifest.json and versions.json set to ${target} (minAppVersion ${manifest.minAppVersion})`);
