import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.launch({headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto('http://127.0.0.1:8766');
await page.getByText('Your photos', {exact: true}).waitFor();
if ((await (await page.request.get('http://127.0.0.1:8766/api/photos')).json()).length === 0) {
  await page.locator('input[type=file]').setInputFiles(Array.from({length: 20}, (_, i) => `.local/qa-photos/${String(i+1).padStart(2, '0')}.jpg`));
}
for (let i = 0; i < 180; i++) {
  const state = await (await page.request.get('http://127.0.0.1:8766/api/status')).json();
  if (i % 10 === 0 || state.failed) console.log(JSON.stringify(state));
  if (state.failed) throw Error(state.model_error);
  if (state.ready === 20) break;
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(2000);
await page.screenshot({path: '.local/ui-gallery.png', fullPage: true});
await page.setViewportSize({width: 390, height: 844});
await page.waitForTimeout(500);
await page.screenshot({path: '.local/ui-mobile.png', fullPage: true});
console.log('Mobile:', await page.evaluate(() => ({width: innerWidth, scrollWidth: document.documentElement.scrollWidth, sidebarLeft: getComputedStyle(document.querySelector('.sidebar')).left})));
await page.getByRole('button', {name: 'Toggle navigation'}).click();
await page.waitForTimeout(300);
await page.getByRole('button', {name: 'Favorites', exact: true}).click();
await page.getByText('Keep your favorites close').waitFor();
await page.getByRole('button', {name: 'Toggle navigation'}).click();
await page.getByRole('button', {name: 'Photos', exact: true}).click();
await page.setViewportSize({width: 1440, height: 1000});
await page.getByRole('textbox', {name: 'Describe a photo'}).fill('a cat');
await page.getByRole('button', {name: 'Search photos', exact: true}).click();
await page.getByText('Ranked by relevance').waitFor({timeout: 180000});
await page.screenshot({path: '.local/ui-search.png', fullPage: true});
await page.locator('.photo-open').first().click();
await page.getByRole('button', {name: 'Photo information'}).click();
await page.screenshot({path: '.local/ui-viewer.png'});
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Escape');
await page.getByRole('button', {name: 'Settings', exact: true}).first().click();
await page.screenshot({path: '.local/ui-settings.png'});
await page.getByRole('button', {name: 'Close settings'}).click();
fs.writeFileSync('.local/browser-qa.json', JSON.stringify({errors}, null, 2));
await browser.close();
if (errors.length) throw Error(errors.join('\n'));
