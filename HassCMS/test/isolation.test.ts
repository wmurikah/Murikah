import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    return item.isDirectory() ? files(path) : [path];
  });
}

test('CMS source imports stay inside its own package', () => {
  for (const file of files(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes("from '@/") && !text.includes('from "@/'), file);
    for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\(\s*)['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (!spec.startsWith('.') && !spec.startsWith('@hasscms/')) continue;
      const path = spec.startsWith('@hasscms/')
        ? resolve(root, 'src', spec.slice('@hasscms/'.length))
        : resolve(dirname(file), spec);
      const rel = relative(root, path);
      assert.ok(rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), `${file}: ${spec}`);
    }
  }
});

test('CMS dependencies do not reference another checkout', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const spec of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.ok(!/^(file:|link:|workspace:)/.test(String(spec)), String(spec));
  }
});

test('standalone Worker does not import another product', () => {
  const worker = readFileSync(join(root, 'src/worker.ts'), 'utf8');
  assert.ok(!/from ['"].*(?:grc|engr|Tutor|\.\.\/)/.test(worker));
  const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
  assert.equal(config.name, 'hass-cms');
  assert.equal(config.main, './src/worker.ts');
  assert.equal(config.assets.run_worker_first, true);
});
