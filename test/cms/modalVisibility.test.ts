import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

test('CmsModal is invisible until its native open attribute is set', () => {
  const modal = read('src/components/cms/CmsModal.astro');
  assert.match(modal, /hidden \[&\[open\]\]:flex flex-col overflow-hidden/);
  assert.ok(!/<dialog[^>]*\sopen(?:\s|=|>)/s.test(modal), 'CmsModal must never render open by default');
});

test('all CmsModal close controls use the shared close lifecycle', () => {
  const modal = read('src/components/cms/CmsModal.astro');
  assert.match(modal, /data-cms-modal-close/);

  const overlay = read('src/components/cms/CmsOverlayScript.astro');
  assert.match(overlay, /\[data-cms-modal-open\]/);
  assert.match(overlay, /\[data-cms-modal-close\]/);
  assert.match(overlay, /dialog\.showModal\(\)/);
  assert.match(overlay, /dialog\.close\(\)/);
});

test('Import history modal is button-triggered and Cancel closes it', () => {
  const history = read('src/pages/cms/app/data/history.astro');
  assert.match(history, /data-cms-modal-open="cms-clear-history"/);
  assert.match(history, /<CmsModal[\s\S]*id="cms-clear-history"/);
  assert.match(history, /<CmsButton variant="ghost" data-cms-modal-close>\s*Cancel\s*<\/CmsButton>/);
});
