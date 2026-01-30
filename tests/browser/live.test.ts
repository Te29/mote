import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchBrowser, closeBrowser, navigateTo, takeScreenshot } from '../../src/browser.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Live tests rely on external websites and real browser (not mocked)
// Run with: npm run test:browser:live
describe('Browser Module - Live Tests', () => {
  let browserSession: Awaited<ReturnType<typeof launchBrowser>>;
  const screenshotDir = path.join(__dirname, '../data/browser_live');

  beforeAll(() => {
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
  });

  afterAll(async () => {
    if (browserSession?.browser) {
      await closeBrowser(browserSession.browser);
    }
  });

  it('Stealth Mode: should hide webdriver property on real site', async () => {
    browserSession = await launchBrowser({
      headless: true,
      slowMo: 0,
      profilePath: undefined,
      stealth: true, // Enable stealth
      timeoutDefault: 10000,
      timeoutNavigation: 10000,
      timeoutElement: 5000,
      postNavDelay: 500
    });

    // Navigate to a simple page
    await navigateTo(browserSession.page, 'https://example.com');

    // Check navigator.webdriver
    const isWebdriver = await browserSession.page.evaluate(() => {
      return navigator.webdriver;
    });

    // In stealth mode, this should be undefined or false
    expect(isWebdriver).toBeFalsy();
  });

  it('Screenshot: should save image file', async () => {
    // Reuse session
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(screenshotDir, `screenshot-${timestamp}.png`);

    await takeScreenshot(browserSession.page, screenshotPath);

    // Verify file exists and has size
    expect(fs.existsSync(screenshotPath)).toBe(true);
    const stats = fs.statSync(screenshotPath);
    expect(stats.size).toBeGreaterThan(100); // Should be non-empty
    
    console.log(`Verified screenshot saved to: ${screenshotPath}`);
  });
});
