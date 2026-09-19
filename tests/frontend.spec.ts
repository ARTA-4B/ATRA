import { test, expect } from '@playwright/test';

test('public and dashboard routes render without page overflow or runtime errors', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const routes = ['/', '/market', '/install', '/docs', '/docs/security', '/docs/status', '/app/overview', '/app/market', '/app/agents', '/app/auto-trade', '/app/auto-lp', '/app/wallet', '/app/risk', '/app/activity', '/app/telegram', '/app/settings', '/app/setup'];
  for (const route of routes) {
    await page.goto('/#' + route); await expect(page.locator('h1')).toBeVisible();
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), route).toBeTruthy();
    await page.screenshot({ path: `artifacts/${test.info().project.name}-${route.replaceAll('/', '-') || 'home'}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});

test('market filters, research, watchlist, and provider states', async ({ page }) => {
  await page.goto('/#/app/market');
  await expect(page.getByRole('button', { name: 'View ETH on Base', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search assets or pairs' }).fill('SOL');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'View SOL on Solana', exact: true }).click();
  await page.getByRole('button', { name: 'Research this market' }).click();
  await expect(page.getByText('NO ACTION', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add SOL Solana to watchlist' }).click();
  await page.getByRole('button', { name: 'Watchlist', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Close market details' }).click();
  await page.getByText('Preview states', { exact: true }).click();
  await page.getByLabel('Market preview state').selectOption('error');
  await expect(page.getByRole('heading', { name: 'Provider unavailable' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Market preview state').selectOption('stale');
  await expect(page.getByText('Stale snapshot.', { exact: false })).toBeVisible();
});

test('wallet review blocks execution and export never reveals a key', async ({ page }) => {
  await page.goto('/#/app/wallet'); await page.getByRole('button', { name: 'Withdraw', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();
  await page.getByLabel('Destination address').fill('0x1111111111111111111111111111111111111111');
  await page.getByLabel('Amount (USDC)').fill('25');
  await page.getByRole('button', { name: 'Review withdrawal' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Check runtime & confirm' }).click();
  await expect(page.getByRole('alert')).toContainText('local ATRA runtime is required');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByText('Advanced wallet controls').click();
  await page.getByRole('button', { name: 'Review wallet export' }).click();
  await expect(page.getByLabel('Local password')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Authenticate locally' })).toBeDisabled();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Authenticate locally' }).click();
  await expect(page.getByRole('alert')).toContainText('local ATRA runtime is required');
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('risk validation, persistence and emergency recovery', async ({ page }) => {
  await page.goto('/#/app/risk');
  await page.getByLabel('Maximum trade size (USD)').fill('7000');
  await page.getByRole('button', { name: 'Save risk limits' }).click();
  await expect(page.getByRole('alert')).toContainText('cannot exceed');
  await page.getByLabel('Maximum trade size (USD)').fill('300');
  await page.getByRole('button', { name: 'Save risk limits' }).click();
  await page.reload(); await expect(page.getByLabel('Maximum trade size (USD)')).toHaveValue('300');
  await page.getByRole('button', { name: 'Emergency Stop', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Confirm Emergency Stop' })).toBeDisabled();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Confirm Emergency Stop' }).click();
  await expect(page.getByText('Emergency Stop is active.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Review recovery' }).click();
  await page.getByRole('button', { name: 'Clear demo stop and stay paused' }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
});

test('onboarding completes in paper mode without pretending wallets exist', async ({ page }) => {
  await page.goto('/#/app/setup');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create Agent Wallets', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('local ATRA runtime');
  await expect(page.getByText('Not created', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Continue preview' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Open Dashboard' }).click();
  await expect(page).toHaveURL(/app\/overview/);
  await page.getByRole('button', { name: 'Review Live Mode' }).click();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Check live eligibility' }).click();
  await expect(page.getByRole('alert')).toContainText('local ATRA runtime');
  await expect(page.getByLabel('Local re-authentication')).toBeDisabled();
});
