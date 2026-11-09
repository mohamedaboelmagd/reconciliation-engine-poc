// Captures the dashboard with a headless browser. Requires the API running on :3000 (npm run serve).
// Uses system Chrome (CHROME_PATH) or Playwright's bundled Chromium if installed.
import { chromium } from 'playwright-core';

const url = process.env.APP_URL ?? 'http://localhost:3000/';
const executablePath = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('app-match-table tbody tr');
await page.screenshot({ path: 'docs/screenshot.png', fullPage: true });
await page.getByRole('button', { name: /Audit trail/ }).click();
await page.waitForSelector('app-audit-trail tbody tr');
await page.waitForTimeout(400);
await page.screenshot({ path: 'docs/screenshot-audit.png', fullPage: false });
await page.getByRole('button', { name: /Unmatched/ }).click();
await page.waitForSelector('app-unmatched-panel');
await page.waitForTimeout(400);
await page.screenshot({ path: 'docs/screenshot-unmatched.png', fullPage: false });
await browser.close();
console.log('saved docs/screenshot.png, docs/screenshot-audit.png, docs/screenshot-unmatched.png');
