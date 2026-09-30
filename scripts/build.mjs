// Builds dist/backend.mjs – the whole backend in one file. Running it needs Node.js 18+ and
// nothing else (no node_modules). Also puts the Docker health check next to it.
//
//   npm run build
import { copyFileSync, mkdirSync } from 'node:fs';
import { buildId } from './build-id.mjs';

// esbuild comes from devDependencies; ESBUILD=<path to esbuild's main.js> can point elsewhere
const { build } = await import(process.env.ESBUILD ?? 'esbuild');
const id = buildId();
mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['server/main.ts'],
  outfile: 'dist/backend.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node18'],
  legalComments: 'none',
  logLevel: 'warning',
  define: { __BUILD_ID__: JSON.stringify(id) },
  banner: { js: `// Mana Chess backend (verzió: ${id}). Indítás: node backend.mjs – lásd README.` },
});
copyFileSync('docker/healthcheck.mjs', 'dist/healthcheck.mjs');
console.log(`dist/backend.mjs – verzió (a játékszabályok ujjlenyomata): ${id}`);
