import { build } from 'esbuild';

await build({
    entryPoints: ['js/schema_extractor_entry.js'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome114'],
    outfile: 'js/schema_extractor.bundle.js',
    sourcemap: false,
    logLevel: 'info'
});
