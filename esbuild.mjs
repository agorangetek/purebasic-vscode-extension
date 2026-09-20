/*
 * Bundles the extension into a single dist/extension.js.
 *
 *   node esbuild.mjs            one-off build
 *   node esbuild.mjs --watch    rebuild on change
 */
import { build, context } from 'esbuild';

const options = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'dist/extension.js',
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	external: ['vscode'],
	sourcemap: true,
	minify: process.argv.includes('--minify'),
	logLevel: 'info',
};

if (process.argv.includes('--watch')) {
	const ctx = await context(options);
	await ctx.watch();
	console.log('watching for changes...');
} else {
	await build(options);
}
