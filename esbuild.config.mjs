import esbuild from 'esbuild';
import process from 'node:process';
import fs from 'node:fs';
import builtins from 'builtin-modules';

const production = process.argv[2] === 'production';

// Dev builds copy the bundle straight into a test vault's plugin folder so
// Obsidian's "Reload app without saving" picks up changes immediately.
// Put the absolute path to <vault>/.obsidian/plugins/awork-sync in .vault-path.
const vaultPath = fs.existsSync('.vault-path')
  ? fs.readFileSync('.vault-path', 'utf8').trim()
  : null;

const copyToVault = {
  name: 'copy-to-vault',
  setup(build) {
    build.onEnd(() => {
      if (!vaultPath) return;
      fs.mkdirSync(vaultPath, { recursive: true });
      for (const file of ['main.js', 'manifest.json']) {
        if (fs.existsSync(file)) fs.copyFileSync(file, `${vaultPath}/${file}`);
      }
      if (fs.existsSync('styles.css')) fs.copyFileSync('styles.css', `${vaultPath}/styles.css`);
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', ...builtins],
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: production,
  plugins: vaultPath ? [copyToVault] : [],
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
