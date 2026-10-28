import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const browser = await chromium.launch({headless: true});
try {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().endsWith('/api/search')) console.log('Search HTTP', response.status()); });
  await page.goto('http://127.0.0.1:8766');
  await page.locator('.photo-open').nth(19).waitFor();
  for (const tile of await page.locator('.photo-open').all()) await tile.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 0));
  const favorite = page.locator('.favorite-button').first();
  await favorite.click({force: true});
  await page.getByRole('button', {name: 'Favorites', exact: true}).click();
  await page.waitForFunction(() => document.querySelectorAll('.photo-open').length === 1);
  await page.locator('.favorite-button').click({force: true});
  await page.getByText('Keep your favorites close').waitFor();
  await page.getByRole('button', {name: 'Photos', exact: true}).click();

  async function cycle(index) {
    await page.locator('.photo-open').nth(index % 20).click();
    await page.locator('.full-photo').evaluate(image => image.decode());
    await page.keyboard.press('Escape');
  }
  for (let i = 0; i < 20; i++) await cycle(i);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const browserCDP = await browser.newBrowserCDPSession();
  async function memory() {
    await cdp.send('HeapProfiler.collectGarbage');
    const metrics = (await cdp.send('Performance.getMetrics')).metrics;
    const pids = (await browserCDP.send('SystemInfo.getProcessInfo')).processInfo.filter(p => p.type === 'renderer').map(p => p.id);
    const privateBytes = Number(execFileSync('.venv/Scripts/python.exe', ['-c', `import psutil; print(sum(psutil.Process(p).memory_info().private for p in ${JSON.stringify(pids)}))`], {encoding: 'utf8'}).trim());
    return {jsHeap: metrics.find(m => m.name === 'JSHeapUsedSize').value, rendererPrivateBytes: privateBytes};
  }
  const baseline = await memory();
  for (let i = 0; i < 100; i++) await cycle(i);
  const after100 = await memory();
  for (let i = 0; i < 100; i++) await cycle(i);
  const after200 = await memory();
  for (let i = 0; i < 500; i++) await cycle(i);
  const final = await memory();
  fs.writeFileSync('.local/ui-memory-qa.json', JSON.stringify({baseline, after100, after200, final}, null, 2));
  console.log('Memory', JSON.stringify({baseline, after100, after200, final}));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({path: '.local/ui-gallery.png', fullPage: true});

  await page.waitForFunction(async () => (await (await fetch('/api/status')).json()).ready === 20, null, {timeout: 180000});

  await page.getByRole('textbox', {name: 'Describe a photo'}).fill('a cat');
  await page.getByRole('button', {name: 'Search photos', exact: true}).click();
  try { await page.getByText('Ranked by relevance').waitFor({timeout: 30000}); }
  catch (error) {
    await page.screenshot({path: '.local/ui-failure.png', fullPage: true});
    console.log('Page after search:', await page.locator('body').innerText());
    throw error;
  }
  if (await page.locator('.photo-open').first().getAttribute('aria-label') !== 'Open 04.jpg') throw Error('Incorrect first result');
  const secondTab = await context.newPage();
  await secondTab.goto('http://127.0.0.1:8766');
  await secondTab.locator('.photo-open').nth(19).waitFor();
  await secondTab.close();
  await page.screenshot({path: '.local/ui-search.png', fullPage: true});

  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole('button', {name: 'Clear search'}).click();
  await page.screenshot({path: '.local/ui-mobile.png', fullPage: true});
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile overflow');
  await page.getByRole('button', {name: 'Toggle navigation'}).click();
  await page.getByRole('button', {name: 'Favorites', exact: true}).click();
  await page.getByText('Keep your favorites close').waitFor();
  const production = await context.newPage();
  await production.goto('http://127.0.0.1:8765');
  await production.getByText('Your photos, a few words away').waitFor();
  await production.screenshot({path: '.local/ui-ready-empty.png', fullPage: true});
  const report = {errors, baseline, after100, after200, final, privateGrowthPercent: (final.rendererPrivateBytes / after200.rendererPrivateBytes - 1) * 100, viewerCycles: 700, mobileOverflow: false};
  fs.writeFileSync('.local/ui-qa.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) throw Error(errors.join('\n'));
} finally { await browser.close(); }
