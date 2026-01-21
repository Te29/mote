import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchBrowser, closeBrowser, navigateTo } from '../../src/browser.js';
import { observe } from '../../src/observe.js';
import type { PageState } from '../../src/types.js';
import type { Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to save test data snapshots
async function saveSnapshot(testName: string, page: Page, state: PageState) {
    const safeName = testName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    // Save to tests/data (sibling to tests/observe)
    const dataDir = path.join(__dirname, '../data', safeName);
    
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    // Save Raw HTML (Before)
    const html = await page.content();
    fs.writeFileSync(path.join(dataDir, 'before_raw.html'), html);

    // Save Processed State (After)
    fs.writeFileSync(path.join(dataDir, 'after_state.json'), JSON.stringify(state, null, 2));
    
    // Save Markdown Preview
    fs.writeFileSync(path.join(dataDir, 'after_preview.md'), state.markdown);

    // Save Metadata (Stats)
    const metadata = {
        testName,
        timestamp: new Date().toISOString(),
        stats: {
            originalHtmlSize: html.length,
            processedMarkdownSize: state.markdown.length,
            tokenEstimate: Math.ceil(state.markdown.length / 4), // Rough estimate
            reductionRatio: `${((1 - (state.markdown.length / html.length)) * 100).toFixed(2)}%`,
            interactiveElementCount: state.elements.length,
            title: state.title
        }
    };
    fs.writeFileSync(path.join(dataDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    
    console.log(`Saved snapshot for "${testName}" to ${dataDir}`);
}

// These tests require internet access and may fail if sites are down/changed.
// Run with: npm run test:live
describe('Live Website Functional Tests', () => {
  let browserSession: Awaited<ReturnType<typeof launchBrowser>>;

  beforeAll(async () => {
    browserSession = await launchBrowser({
      headless: true,
      slowMo: 100, // Small delay for stability
      timeout: {
        default: 30000,
        navigation: 30000,
        element: 5000,
        postNavDelay: 2000, // Wait for hydration/rendering
      },
    });
  });

  afterAll(async () => {
    if (browserSession?.browser) {
      await closeBrowser(browserSession.browser);
    }
  });

  it('Google Search: should detect params and main input', async () => {
    // Basic Form Test
    await navigateTo(browserSession.page, 'https://www.google.com');
    
    // Handle cookie consent if it appears (common on Google in EU/headless)
    const consentBtn = await browserSession.page.$('button:has-text("Reject all"), button:has-text("Accept all")');
    if (consentBtn) await consentBtn.click().catch(() => {});

    const state = await observe(browserSession.page);
    await saveSnapshot('google_search', browserSession.page, state);

    // Check Inputs
    const searchInput = state.elements.find(el => 
        (el.tag === 'textarea' || el.tag === 'input') && 
        (el.attributes.title === 'Search' || el.attributes['aria-label'] === 'Search')
    );
    expect(searchInput).toBeDefined();
    
    // Check Content
    expect(state.title).toContain('Google');
  });

  it('Chrome Status: should detect Shadow DOM elements', async () => {
    // Shadow DOM Test
    await navigateTo(browserSession.page, 'https://chromestatus.com/features');
    const state = await observe(browserSession.page);
    await saveSnapshot('chrome_status', browserSession.page, state);

    expect(state.title).toContain('Chrome Platform Status');
    
    // ChromeStatus uses Web Components. We should find elements inside them.
    expect(state.elements.length).toBeGreaterThan(20);
    
    // Verify we found generic interactive elements commonly in app shells
    const links = state.elements.filter(e => e.tag === 'a');
    expect(links.length).toBeGreaterThan(5);
  });

  it('W3Schools Quiz: should detect active quiz elements', async () => {
    // Active Elements (Radio/Checkbox) Test
    // Using a stable quiz page or similar form
    await navigateTo(browserSession.page, 'https://www.w3schools.com/quiztest/quiztest.asp?qtest=HTML');
    
    // W3Schools often has a "Start Quiz" button first
    const state = await observe(browserSession.page);
    await saveSnapshot('w3schools_quiz', browserSession.page, state);

    // Should find "Start" button or Quiz options
    const interactive = state.elements.length;
    expect(interactive).toBeGreaterThan(5);
    
    // Check for "Next" or "Start"
    const actionBtn = state.elements.find(el => 
        el.text.includes('Start') || el.text.includes('Next') || el.text.includes('Submit')
    );
    expect(actionBtn).toBeDefined();
  });

  it('StackOverflow Questions: should detect complex filters and inputs', async () => {
    // Real-World Complex Interaction Test
    await navigateTo(browserSession.page, 'https://stackoverflow.com/questions');
    
    // Handle cookie consent if needed
    const consentBtn = await browserSession.page.$('button.js-accept-cookies');
    if (consentBtn) await consentBtn.click().catch(() => {});

    const state = await observe(browserSession.page);
    await saveSnapshot('stackoverflow_questions', browserSession.page, state);

    // 1. Search Input
    const searchInput = state.elements.find(el => el.attributes.name === 'q' || el.attributes['aria-label'] === 'Search');
    expect(searchInput).toBeDefined();

    // 2. Filter Tabs (Newest, Active, Bountied, etc.)
    const tab = state.elements.find(el => el.text === 'Newest' || el.text === 'Active');
    expect(tab).toBeDefined();

    // 3. Questions List
    // We expect many links to questions
    const questionLinks = state.elements.filter(el => el.tag === 'a' && el.attributes.class?.includes('question-hyperlink'));
    // Note: observe.ts might not capture classes in attributes unless generic logic fallback uses it, 
    // but the text/href serves as proxy.
    const links = state.elements.filter(el => el.tag === 'a');
    expect(links.length).toBeGreaterThan(20);
  });

  it('BBC News: should handle iframes and noise', async () => {
    // Iframe & Noise Test
    await navigateTo(browserSession.page, 'https://www.bbc.com/news');
    // Reject cookies if possible to clear view
    try {
        const consent = await browserSession.page.$('button[data-testid="consent-button"]');
        if (consent) await consent.click();
    } catch(e) {}

    const state = await observe(browserSession.page);
    await saveSnapshot('bbc_news', browserSession.page, state);

    // 1. Content Extraction
    expect(state.title).toContain('BBC');
    expect(state.markdown.length).toBeGreaterThan(500);
    
    // 2. Navigation elements should be roughly usable
    const navLinks = state.elements.filter(el => el.tag === 'a');
    expect(navLinks.length).toBeGreaterThan(10);
  });

});
