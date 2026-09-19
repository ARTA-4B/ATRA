// Renders docs/brand/src/*.html to PNG with the repository's Playwright Chromium.
// Run from the repository root:  node docs/brand/render.mjs [name-filter]
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? '';
const sizes = { pp: [800, 800], 'x-banner': [1500, 500], 'logo-horizontal': [1000, 240] };
const browser = await chromium.launch();
for (const file of readdirSync(join(here, 'src')).filter((f) => f.endsWith('.html') && f.includes(filter))) {
  const kind = Object.keys(sizes).find((k) => file.startsWith(k));
  if (!kind) continue;
  const [w, h] = sizes[kind];
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(here, 'src', file)).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const out = file.replace('.html', kind === 'pp' ? '-800.png' : kind === 'x-banner' ? '-1500x500.png' : '.png');
  await page.screenshot({ path: join(here, out), omitBackground: kind === 'logo-horizontal', clip: { x: 0, y: 0, width: w, height: h } });
  console.log('rendered', out);
  await page.close();
}
await browser.close();
