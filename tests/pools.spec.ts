import { test, expect } from '@playwright/test';

const ca = '0x1111111111111111111111111111111111111111';
const indexedPool = (version: string, i: number) => ({ chainId: 'base', dexId: 'uniswap', pairAddress: `0x${i.toString().repeat(40)}`, labels: [version], baseToken: { address: ca, symbol: 'SMALL', name: 'Test small-cap token' }, quoteToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH' }, liquidity: { usd: 1700 + i }, volume: { h24: 100 + i } });

test('any CA discovery retains V2 V3 V4 and unknown pools, saves draft only', async ({ page }) => {
  await page.route('https://api.dexscreener.com/token-pairs/v1/**', route => route.fulfill({json:[indexedPool('v2',2), indexedPool('v3',3), indexedPool('v4',4), indexedPool('unclassified',5), {...indexedPool('v2',6), baseToken:{address:'0x2222222222222222222222222222222222222222',symbol:'OTHER'}}]}));
  await page.goto('/app/auto-lp');
  await expect(page.getByRole('button',{name:'Find pools',exact:true})).toBeDisabled();
  await page.getByLabel('Token contract address').fill(ca);
  await page.getByRole('button',{name:'Find pools',exact:true}).click();
  await expect(page.getByRole('heading',{name:'4 indexed pools'})).toBeVisible();
  await expect(page.locator('td .badge').getByText('Other / unknown',{exact:true})).toBeVisible();
  await page.getByLabel('Pool version',{exact:true}).selectOption('V4');
  await expect(page.getByRole('button',{name:'Inspect pool'})).toHaveCount(1);
  await page.getByRole('button',{name:'Inspect pool'}).click();
  await expect(page.getByText('Pool key & hook permissions')).toBeVisible();
  await page.getByRole('button',{name:'Configure Auto LP',exact:true}).click();
  await page.getByLabel('Lower price (WETH per SMALL)').fill('0.2');
  await page.getByLabel('Upper price (WETH per SMALL)').fill('0.1');
  await page.getByRole('dialog').getByRole('checkbox').check();
  await page.getByRole('button',{name:'Save paper policy'}).click();
  await expect(page.getByRole('alert')).toContainText('lower price must be below');
  await page.getByLabel('Upper price (WETH per SMALL)').fill('0.3');
  await page.getByRole('button',{name:'Save paper policy'}).click();
  await expect(page.getByText('Paper policy draft saved')).toBeVisible();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('atra.lp-draft')||'{}').mode)).toBe('PAPER');
});

test('discovery handles empty, unavailable and unconfigured networks honestly',async({page})=>{
  await page.route('https://api.dexscreener.com/token-pairs/v1/**',route=>route.fulfill({json:[]}));
  await page.goto('/app/auto-lp');await page.getByLabel('Token contract address').fill(ca);await page.getByRole('button',{name:'Find pools',exact:true}).click();
  await expect(page.getByRole('heading',{name:'No indexed pools found'})).toBeVisible();
  await page.unroute('https://api.dexscreener.com/token-pairs/v1/**');
  await page.route('https://api.dexscreener.com/token-pairs/v1/**',route=>route.fulfill({status:429,json:{}}));
  await page.getByRole('button',{name:'Find pools',exact:true}).click();await expect(page.getByRole('alert')).toContainText('rate limit');
  await page.locator('.pool-search-form').getByRole('combobox').selectOption('Robinhood Chain');await page.getByLabel('Token contract address').fill(ca);await page.getByRole('button',{name:'Find pools',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('not configured');
});

test('reduced motion exposes all content without chart animations',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/');
  await expect(page.locator('.lp-public-section h2')).toContainText('Your token.');
  expect(await page.locator('.portfolio-chart polyline').evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
  expect(await page.locator('.portfolio-chart polyline').evaluate(el=>getComputedStyle(el).strokeDashoffset)).toBe('0px');
});
