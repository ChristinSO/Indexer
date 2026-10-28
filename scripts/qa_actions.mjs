import { chromium } from 'playwright';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const source = fs.readFileSync('.local/qa-photos/04.jpg');
const hash = data => createHash('sha256').update(data).digest('hex');
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage({reducedMotion: 'reduce'});
  await page.goto('http://127.0.0.1:8766');
  await page.locator('.photo-open').nth(19).waitFor();
  await page.locator('input[type=file]').setInputFiles({name: 'qa-removal.jpg', mimeType: 'image/jpeg', buffer: source});
  await page.getByRole('button', {name: 'Open qa-removal.jpg', exact: true}).waitFor({timeout: 30000});
  await page.getByRole('button', {name: 'Open qa-removal.jpg', exact: true}).click();
  await page.getByRole('button', {name: 'Remove photo', exact: true}).click();
  await page.getByRole('alertdialog').getByRole('button', {name: 'Remove photo', exact: true}).click();
  await page.waitForFunction(() => document.querySelectorAll('.photo-open').length === 20, null, {timeout: 30000});
  if (hash(fs.readFileSync('.local/qa-photos/04.jpg')) !== hash(source)) throw Error('Source file changed');
  await page.locator('input[type=file]').setInputFiles({name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('invalid image')});
  await page.getByRole('alert').waitFor();
  if (await page.locator('.photo-open').count() !== 20) throw Error('Invalid import changed library');
  console.log('UI removal, confirmation, invalid upload, and unchanged source file: passed.');
} finally { await browser.close(); }
