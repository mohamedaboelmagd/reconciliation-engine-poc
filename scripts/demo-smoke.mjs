// Smoke test for the static browser demo (local or live): run reconciliation, accept + reject,
// re-import the sample file (idempotent), verify the audit chain, and save screenshots.
// Usage: node scripts/demo-smoke.mjs <url> [screenshot.png]
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:8765/';
const out = process.argv[3] ?? 'docs/live.png';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(url, { waitUntil: 'networkidle' });
await page.getByText('STATIC BROWSER DEMO').waitFor();
const reviewRows = () => page.locator('app-match-table tbody tr:has(button:text("Accept"))').count();
await page.getByRole('button', { name: 'Reset demo' }).click();
await page.getByText('Sample data reloaded').waitFor();
await page.getByRole('button', { name: 'Run reconciliation' }).click();
await page.getByText(/Run complete/).waitFor();
const toast1 = await page.getByText(/Run complete/).textContent();
const before = await reviewRows();
await page.locator('button:text("Accept")').first().click();
await page.getByText(/^Accepted /).waitFor();
await page.locator('button:text("Reject")').first().click();
await page.getByText(/Rejected\./).waitFor();
const after = await reviewRows();
await page.getByRole('button', { name: 'Run reconciliation' }).click();
await page.getByText(/Run complete/).waitFor();
const toast2 = await page.getByText(/Run complete/).textContent();
await page.locator('input[type=file]').setInputFiles('backend/sample-data/nile-foods.bank-feed-oct-2026.csv');
await page.getByText(/already imported|Imported/).waitFor();
const importToast = await page.getByText(/already imported|Imported/).textContent();
await page.waitForTimeout(4200); // let toasts clear
await page.screenshot({ path: out, fullPage: true });
await page.getByRole('button', { name: /Audit trail/ }).click();
await page.waitForSelector('app-audit-trail tbody tr');
const chain = await page.locator('app-audit-trail .pill').first().textContent();
const summary = await page.locator('app-summary-cards').innerText();
console.log(JSON.stringify({ url, firstRun: toast1?.trim(), reviewRowsBefore: before, reviewRowsAfterAcceptReject: after, secondRun: toast2?.trim(), reimport: importToast?.trim(), auditChain: chain?.trim(), summary: summary.replace(/\s+/g, ' ').slice(0, 220), errors }, null, 2));
await browser.close();
if (errors.length || before < 1 || !/verified/.test(chain ?? '')) process.exit(1);
