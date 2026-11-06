/**
 * Materialize database resources for local tooling and deployment.
 * The repository tracks one reviewed JSON catalogue instead of individual SQL
 * files. Generated files are ignored by Git and can be removed at any time.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cataloguePath = join(root, 'tools/db-assets.json');
const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'));
if (process.argv[2] === '--capture') {
  if (process.argv.length !== 4) throw new Error('Usage: restore-db-assets.mjs --capture path.sql');
  const path = resolve(root, process.argv[3]);
  if (!path.startsWith(root + sep) || !/\.sql(?:\.txt)?$/.test(path)) {
    throw new Error('Capture path must be a SQL resource inside this product.');
  }
  const key = relative(root, path).split(sep).join('/');
  catalogue[key] = readFileSync(path, 'utf8').split('\n');
  writeFileSync(cataloguePath, JSON.stringify(Object.fromEntries(Object.entries(catalogue).sort()), null, 2) + '\n');
  console.log(`Captured ${key} in tools/db-assets.json.`);
  process.exit(0);
}
if (process.argv.length > 2) throw new Error('Unknown arguments.');
let restored = 0;
for (const [relativePath, lines] of Object.entries(catalogue)) {
  const path = resolve(root, relativePath);
  if (!path.startsWith(root + sep) || !Array.isArray(lines)) {
    throw new Error(`Invalid database asset entry: ${relativePath}`);
  }
  const source = lines.join('\n');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  restored++;
}
console.log(`Restored ${restored} ignored database resources.`);
