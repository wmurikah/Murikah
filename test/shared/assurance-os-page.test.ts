import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const pageUrl = new URL('../../src/pages/assurance-os.astro', import.meta.url);
const workflowUrl = new URL(
  '../../src/components/assurance-os/AssuranceOsWorkflow.tsx',
  import.meta.url,
);

test('Assurance OS follows the audited product-page section order', async () => {
  const page = await readFile(pageUrl, 'utf8');
  const ids = Array.from(
    page.matchAll(/<section[^>]*\bid="([^"]+)"/g),
    (match) => match[1],
  );

  assert.deepEqual(ids, [
    'hero',
    'trust',
    'how-it-works',
    'features',
    'ai-assistant',
    'audience',
    'security',
    'pricing',
    'faq',
    'final-cta',
  ]);
});

test('hero uses the approved copy, CTAs and a real product capture', async () => {
  const page = await readFile(pageUrl, 'utf8');

  assert.match(page, /One workspace from audit plan to board pack\./);
  assert.match(
    page,
    /Plan engagements, review work papers and track findings\. AI helps you draft\. You decide\./,
  );
  assert.match(page, />\s*Try the public sandbox\s*</);
  assert.match(page, />\s*Book a 20-minute call\s*</);
  assert.match(page, /src="\/images\/assurance-os-trace\.webp"/);
  assert.match(page, /fetchpriority="high"/);
  assert.doesNotMatch(page, /class="eyebrow"/);
  assert.doesNotMatch(page, /\baperture\b/);
  assert.doesNotMatch(page, /font-serif/);
});

test('how it works uses six 16:10 product captures and accessible six-second tabs', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const workflowCss = await readFile(
    new URL('../../src/components/assurance-os/AssuranceOsWorkflow.css', import.meta.url),
    'utf8',
  );
  const assets = ['plan', 'fieldwork', 'review', 'findings', 'remediation', 'report'];

  assert.match(workflow, /const STAGE_MS = 6000/);
  assert.match(workflow, /intersectionRatio \?\? 0\) >= 0\.6/);
  assert.match(workflow, /role="tablist"/);
  assert.match(workflow, /role="tab"/);
  assert.match(workflow, /ArrowRight/);
  assert.match(workflow, /ArrowLeft/);
  assert.match(workflow, /Home/);
  assert.match(workflow, /End/);
  assert.match(workflow, /onMouseEnter=\{\(\) => setHovered\(true\)\}/);
  assert.match(workflow, /onFocusCapture=\{\(\) => setFocused\(true\)\}/);
  assert.match(workflow, /prefers-reduced-motion/);
  assert.match(workflowCss, /animation: aow-fade 300ms/);
  assert.match(workflow, /width="640"/);
  assert.match(workflow, /height="400"/);
  assert.match(workflow, /Try this stage in the sandbox →/);

  for (const asset of assets) {
    const url = new URL(`../../public/images/assurance-os/${asset}.webp`, import.meta.url);
    await access(url);
    const bytes = await readFile(url);
    const metadata = await stat(url);
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP');
    assert.ok(metadata.size < 300_000, `${asset}.webp must stay below 300 KB`);
    assert.match(workflow, new RegExp(`/images/assurance-os/${asset}\\.webp`));
  }
});

test('product proof and copy replace brochure placeholders and unsupported claims', async () => {
  const page = await readFile(pageUrl, 'utf8');

  assert.match(page, /Follow one audit from plan to report\./);
  assert.match(page, /assurance-bento/);
  assert.match(page, /AI can help structure a draft/);
  assert.match(page, /never replaces professional judgement/);
  assert.doesNotMatch(page, /Related reading/);
  assert.doesNotMatch(page, /Your quarterly pack is a click/);
  assert.doesNotMatch(page, /grey wireframe|gray wireframe/i);
});

test('security section states implementation facts without inventing certification or residency', async () => {
  const page = await readFile(pageUrl, 'utf8');

  assert.match(page, /Server-enforced permissions/);
  assert.match(page, /audit trail/);
  assert.match(page, /AES-GCM/);
  assert.match(page, /Cloudflare R2/);
  assert.match(page, /Google Drive/);
  assert.match(page, /SharePoint or OneDrive/);
  assert.match(page, /Dropbox/);
  assert.match(page, /retention rules and legal holds/);
  assert.match(page, /Hosting region, residency, processing terms/);
  assert.doesNotMatch(page, /ISO(?:\/IEC)? 27001 certified/i);
  assert.doesNotMatch(page, /certified to ISO(?:\/IEC)? 27001/i);
});

test('pricing gives every tier features and an action, with Growth highlighted', async () => {
  const page = await readFile(pageUrl, 'utf8');

  assert.match(page, /Starter:/);
  assert.match(page, /Growth:/);
  assert.match(page, /Enterprise:/);
  assert.match(page, /tier\.name === 'Growth'/);
  assert.match(page, /assurance-tier--featured/);
  assert.match(page, /Most common/);
  assert.match(page, /Contract terms are confirmed in writing\./);
  assert.match(page, /enterprise \? PRIMARY_CTA\.href : '\/assurance-os\/sandbox'/);
  assert.match(page, /enterprise \? 'Book a call' : 'Try the sandbox'/);
});

test('Assurance OS uses Platform breadcrumb and the global footer fixes the audit issues', async () => {
  const page = await readFile(pageUrl, 'utf8');
  const footer = await readFile(new URL('../../src/components/Footer.astro', import.meta.url), 'utf8');
  const a11y = await readFile(
    new URL('../../src/components/a11y/AccessibilityAssistant.tsx', import.meta.url),
    'utf8',
  );

  assert.match(page, /\{ label: 'Platform', href: '\/products' \}/);
  assert.doesNotMatch(page, /What we do/);

  assert.match(footer, /murikah-logo-dark\.png/);
  assert.match(footer, /<h2>Product<\/h2>/);
  assert.match(footer, /<h2>Company<\/h2>/);
  assert.match(footer, /<h2>Resources<\/h2>/);
  assert.match(footer, /<h2>Legal<\/h2>/);
  assert.match(footer, /<SubscribeForm/);
  assert.doesNotMatch(footer, /<details[^>]*class="newsletter"/);
  assert.match(footer, /padding: 2\.5rem 0 6rem/);
  assert.doesNotMatch(footer, />MURIKAH</);

  assert.match(a11y, /className="a11y__toggle"[\s\S]*?aria-label="Accessibility options"/);
});
