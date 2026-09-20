// Renders docs/brand/src/*.html to PNG with the repository's Playwright Chromium.
// Run from the repository root:  node docs/brand/render.mjs
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const jobs = [
  { src: 'pp.html', out: 'pp-800.png', w: 800, h: 800 },
  { src: 'x-banner.html', out: 'x-banner-1500x500.png', w: 1500, h: 500 },
  { src: 'logo-horizontal.html', out: 'logo-horizontal.png', w: 1000, h: 260, transparent: true },
];
const browser = await chromium.launch();
for (const job of jobs) {
  const page = await browser.newPage({ viewport: { width: job.w, height: job.h }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(here, 'src', job.src)).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(here, job.out), omitBackground: job.transparent === true, clip: { x: 0, y: 0, width: job.w, height: job.h } });
  console.log('rendered', job.out);
  await page.close();
}
await browser.close();
