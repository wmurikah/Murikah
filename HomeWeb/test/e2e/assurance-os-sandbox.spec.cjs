const { test, expect } = require('@playwright/test');

async function dismissTour(page) {
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

async function openFullScreen(page) {
  const button = page.getByRole('button', { name: 'Open full screen' });
  if (await button.isVisible().catch(() => false)) await button.click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/assurance-os/sandbox/', { waitUntil: 'networkidle' });
  await expect(page.locator('.sb-root')).toBeVisible();
  await dismissTour(page);
});

test('create finding persists across reload and reset restores seed', async ({ page }) => {
  await page.getByRole('button', { name: 'Findings', exact: true }).click();
  await page.getByRole('button', { name: 'Create finding' }).click();

  await page.getByLabel('Engagement').selectOption('ENG-2026-01');
  await page.getByLabel('Process').selectOption('ICT');
  await page.getByLabel('Condition').fill('The sampled quarterly access review did not retain evidence of owner approval for three privileged accounts.');
  await page.getByLabel('Criteria').fill('ISO/IEC 27001 Annex A — identity and access management controls.');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Root cause').fill('The review is completed by email and completion evidence is not mandatory.');
  await page.getByLabel('Risk / effect').fill('Privileged access may remain active without a current business need.');
  await page.getByLabel('Rating').selectOption('High');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Recommendation').fill('Require owner certification and retained evidence before the quarterly review is closed.');
  await page.getByRole('button', { name: 'Create finding' }).click();

  await expect(page.getByText('AUD-2026-041')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'networkidle' });
  await dismissTour(page);
  await page.getByRole('button', { name: 'Findings', exact: true }).click();
  await expect(page.getByText('AUD-2026-041')).toBeVisible();

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('button', { name: 'Findings', exact: true }).click();
  await expect(page.getByText('AUD-2026-041')).toHaveCount(0);
});

test('role switch scopes the interface', async ({ page }) => {
  await page.locator('.sb-role-switch select').selectOption('USR-BOARD');
  await expect(page.getByRole('button', { name: 'Reports', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Findings', exact: true })).toHaveCount(0);

  await page.locator('.sb-role-switch select').selectOption('USR-ICT');
  await expect(page.getByRole('button', { name: 'Actions', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toHaveCount(0);
  await expect(page.getByText('Showing your actions only')).toBeVisible();
});

test('drag action through allowed workflow state', async ({ page }) => {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  const source = page.locator('.sb-kanban__col').filter({ hasText: 'Not Due' }).locator('.sb-kanban__card').first();
  const target = page.locator('.sb-kanban__col').filter({ hasText: /^Pending/ }).first();
  await expect(source).toBeVisible();
  await source.dragTo(target);
  await expect(page.locator('.sb-toast')).toContainText('Changed');
});

test('generate quarterly pack and expose browser PDF action', async ({ page }) => {
  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await page.getByRole('button', { name: 'Generate quarterly committee pack' }).click();
  await expect(page.locator('#sandbox-report-preview')).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('button', { name: 'Download PDF' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
});

test('keyboard command palette and findings row navigation work', async ({ page }) => {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.getByPlaceholder('Search screens, engagements and findings…').fill('findings');
  await page.getByRole('button', { name: /Findings/ }).first().click();
  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: /AUD-2026-/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /AUD-2026-/ })).toHaveCount(0);
});

test('capture six product screenshots', async ({ page }) => {
  test.skip(!process.env.SANDBOX_SCREENSHOT_DIR, 'Screenshot path is only set in the acceptance workflow.');
  const dir = process.env.SANDBOX_SCREENSHOT_DIR;

  await page.setViewportSize({ width: 1440, height: 920 });
  await openFullScreen(page);

  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await page.screenshot({ path: dir + '/assurance-os-dashboard.png', fullPage: false });

  await page.getByRole('button', { name: 'Findings', exact: true }).click();
  await page.locator('.sb-table tbody tr').first().click();
  await page.screenshot({ path: dir + '/assurance-os-findings-drawer.png', fullPage: false });

  await page.getByRole('button', { name: 'AI assistant' }).click();
  await page.getByRole('button', { name: 'Draft root cause' }).click();
  await expect(page.locator('.sb-ai__result p')).toContainText('likely root cause', { timeout: 3000 });
  await page.screenshot({ path: dir + '/assurance-os-finding-ai.png', fullPage: false });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.screenshot({ path: dir + '/assurance-os-actions-kanban.png', fullPage: false });

  await page.getByRole('button', { name: 'Reports', exact: true }).click();
  await page.getByRole('button', { name: 'Generate quarterly committee pack' }).click();
  await expect(page.locator('#sandbox-report-preview')).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: dir + '/assurance-os-committee-pack.png', fullPage: false });

  await page.getByRole('button', { name: 'Audit log', exact: true }).click();
  await page.screenshot({ path: dir + '/assurance-os-audit-log.png', fullPage: false });
});
