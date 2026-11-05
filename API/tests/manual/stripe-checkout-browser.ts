import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const requireAdmin = createRequire(new URL('../../../Admin/package.json', import.meta.url));
const { chromium } = requireAdmin('@playwright/test') as typeof import('@playwright/test');

export async function paySandboxCheckout(url: string, successUrl: string) {
  assert.equal(new URL(url).hostname, 'checkout.stripe.com');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage({ locale: 'en-GB' }); page.setDefaultTimeout(45000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('#cardNumber').fill('4242424242424242');
    await page.locator('#cardExpiry').fill('1235'); await page.locator('#cardCvc').fill('123');
    await page.locator('#billingName').fill('Nessie Sandbox Evaluation');
    await page.locator('#billingCountry').selectOption('GB');
    await page.getByRole('button', { name: 'Enter address manually' }).click();
    await page.locator('#billingAddressLine1').fill('1 Payment Test Road');
    await page.locator('#billingLocality').fill('London'); await page.locator('#billingPostalCode').fill('SW1A 1AA');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(successUrl, { timeout: 90000, waitUntil: 'commit' });
  } finally { await browser.close(); }
}
