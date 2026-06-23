/**
 * Build two artifacts with esbuild:
 *   1. dist/index.mjs                       — ESM library (demo import + future npm publish)
 *   2. dist/affaldsshop-checkout.<ver>.js   — self-mounting IIFE widget for the WordPress theme,
 *                                             uploaded to https://widgets.genbrugscms.cloud/ (versioned
 *                                             filename = cache-busting). UMD/ESM is reserved for the lib;
 *                                             a <script>-loaded self-mounting widget needs no module interop.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
const ver = pkg.version;

const common = { bundle: true, target: ['es2018'], logLevel: 'info' };

await build({
  ...common,
  entryPoints: ['src/adressevaelger/index.js'],
  outfile: 'dist/index.mjs',
  format: 'esm',
});

await build({
  ...common,
  entryPoints: ['src/adapters/affaldsshop-checkout.js'],
  outfile: `dist/affaldsshop-checkout.${ver}.js`,
  format: 'iife',
  minify: true,
});

console.log(`\nBuilt dist/index.mjs and dist/affaldsshop-checkout.${ver}.js`);
