'use strict';

const esbuild = require('esbuild');

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const production = args.includes('--production');

const baseConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  logLevel: production ? 'silent' : 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(baseConfig);
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
  } else {
    await esbuild.build(baseConfig);
    console.log('[esbuild] build complete:', baseConfig.outfile);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
