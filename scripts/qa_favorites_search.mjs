import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const browser = await chromium.launch({headless: true});
const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
const base = 'http://127.0.0.1:8766';
const token = (await (await context.request.get(`${base}/api/session`)).json()).token;
const original = await (await context.request.get(`${base}/api/photos`)).json();
const initiallyFavorited = new Set(original.filter(p => p.favorite).map(p => p.id));
let page;
async function toggle(id) {
  const result = await context.request.post(`${base}/api/photos/${id}/favorite`, {headers: {'x-indexer-token': token}});
  assert.equal(result.status(), 200);
}
try {
  for (const photo of original.filter(p => p.favorite)) await toggle(photo.id);
  const dog = original.find(p => p.name === '03.jpg');
  const books = original.find(p => p.name === '17.jpg');
  const cat = original.find(p => p.name === '04.jpg');
  await toggle(dog.id);
  await toggle(books.id);
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api/search')) console.log('Search request:', request.postData()); });
  await page.goto(base);
  await page.locator('.photo-open').nth(19).waitFor();
  await page.getByRole('button', {name: 'Favorites', exact: true}).click();
  assert.equal(await page.locator('.photo-open').count(), 2);
  await page.getByPlaceholder('Search favorites').fill('a cat');
  const pending = page.waitForResponse(r => r.url().endsWith('/api/search'));
  await page.getByRole('button', {name: 'Search favorites', exact: true}).click();
  const response = await pending;
  assert.equal(response.request().postDataJSON().scope, 'favorites');
  const result = await response.json();
  assert.equal(result.scope, 'favorites');
  assert.equal(result.searched, 2);
  assert.deepEqual(result.hits.map(h => h.id), [dog.id, books.id]);
  assert.ok(result.hits.every(h => h.id !== cat.id));
  await page.getByRole('button', {name: 'All favorites', exact: true}).waitFor();
  assert.match(await page.getByRole('button', {name: 'Favorites', exact: true}).getAttribute('class'), /active/);
  assert.equal(await page.locator('.photo-open').count(), 2);
  await page.getByRole('button', {name: 'Filtered search', exact: true}).click();
  await page.getByRole('button', {name: '60%', exact: true}).click();
  assert.equal(await page.locator('.photo-open').count(), 1);
  assert.equal(await page.locator('.photo-open').getAttribute('aria-label'), 'Open 03.jpg');
  await page.getByRole('button', {name: 'Ranked search', exact: true}).click();
  await page.mouse.move(5, 5);
  await page.screenshot({path: '.local/favorites-search.png', fullPage: true});
  await page.getByRole('button', {name: 'Unfavorite 03.jpg', exact: true}).click({force: true});
  await page.waitForFunction(() => document.querySelectorAll('.photo-open').length === 1);
  assert.equal(await page.locator('.photo-open').getAttribute('aria-label'), 'Open 17.jpg');
  await page.locator('.photo-open').click();
  await page.getByRole('button', {name: 'Favorite photo', exact: true}).click();
  await page.getByText('No searchable favorites in these results', {exact: true}).waitFor();
  assert.equal(await page.locator('.viewer').count(), 0);
  assert.equal(await page.locator('.photo-open').count(), 0);

  const emptyPromise = page.waitForResponse(r => r.url().endsWith('/api/search'));
  await page.getByRole('button', {name: 'Search favorites', exact: true}).click();
  const empty = await (await emptyPromise).json();
  assert.deepEqual(empty, {hits: [], searched: 0, milliseconds: 0, scope: 'favorites'});
  await page.getByRole('button', {name: 'All favorites', exact: true}).click();
  await page.getByText('Keep your favorites close').waitFor();

  await page.getByRole('button', {name: 'Photos', exact: true}).click();
  await page.getByPlaceholder('Search your photos').fill('a cat');
  const [allResponse] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/api/search')),
    page.getByRole('button', {name: 'Search photos', exact: true}).click(),
  ]);
  assert.equal(allResponse.request().postDataJSON().scope, 'photos');
  const all = await allResponse.json();
  assert.equal(all.searched, 20);
  assert.equal(all.hits[0].id, cat.id);
  await page.getByRole('button', {name: 'All photos', exact: true}).waitFor();
  assert.equal(await page.locator('.photo-open').count(), 20);

  // Navigation must cancel a search from the previous page, even if its reply is late.
  let intercepted;
  const requestStarted = new Promise(resolve => { intercepted = resolve; });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/search', async route => {
    intercepted();
    await held;
    await route.fulfill({json: all}).catch(() => {});
  });
  await page.getByRole('button', {name: 'Search photos', exact: true}).click();
  await requestStarted;
  await page.getByRole('button', {name: 'Favorites', exact: true}).click();
  release();
  await page.getByText('Keep your favorites close').waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.photo-open').count(), 0);
  assert.match(await page.getByRole('button', {name: 'Favorites', exact: true}).getAttribute('class'), /active/);
  assert.deepEqual(errors, []);
  fs.writeFileSync('.local/favorites-search-qa.json', JSON.stringify({favoritesSearched: result.searched, fullLibrarySearched: all.searched, emptyFavorites: empty, lateResponseIgnored: true, errors}, null, 2));
  console.log('Favorites scope, both modes, removal, empty favorites, full-library search, and navigation cancellation: passed.');
} catch (error) {
  if (page && !page.isClosed()) {
    console.log('Page state:', await page.locator('body').innerText());
    console.log('Search value:', await page.locator('input[aria-label="Describe a photo"]').inputValue());
    await page.screenshot({path: '.local/favorites-search-failure.png', fullPage: true});
  }
  throw error;
} finally {
  const current = await (await context.request.get(`${base}/api/photos`)).json();
  for (const photo of current) if (!!photo.favorite !== initiallyFavorited.has(photo.id)) await toggle(photo.id);
  await browser.close();
}
