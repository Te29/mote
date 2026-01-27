import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { launchBrowser, closeBrowser, navigateTo, getPageContent } from '../../src/browser.js';
import { chromium } from 'playwright';

// Mock everything from playwright
vi.mock('playwright', () => {
    const page = {
        goto: vi.fn(),
        waitForTimeout: vi.fn(),
        url: vi.fn(() => 'http://test.com'),
        title: vi.fn(() => 'Test Title'),
        content: vi.fn(() => '<html>Test Content</html>'),
        setDefaultTimeout: vi.fn(),
        on: vi.fn(),
        screenshot: vi.fn(),
    };

    const context = {
        newPage: vi.fn(() => Promise.resolve(page)),
        addInitScript: vi.fn(),
        pages: vi.fn(() => []),
        browser: vi.fn(), // For persistent context
    };

    const browser = {
        newContext: vi.fn(() => Promise.resolve(context)),
        close: vi.fn(),
        version: vi.fn(() => '1.0.0'),
    };

    return {
        chromium: {
            launch: vi.fn(() => Promise.resolve(browser)),
            launchPersistentContext: vi.fn(() => Promise.resolve({ ...context, browser: () => browser })),
        },
    };
});

describe('Browser Module', () => {
    const config = {
        headless: true,
        slowMo: 0,
        stealth: true,
        timeoutDefault: 1000,
        timeoutNavigation: 1000,
        timeoutElement: 1000,
        postNavDelay: 0
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should launch a browser and return session', async () => {
        const session = await launchBrowser(config as any);
        
        expect(chromium.launch).toHaveBeenCalledWith(expect.objectContaining({
            headless: true,
            slowMo: 0
        }));
        expect(session.browser).toBeDefined();
        expect(session.context).toBeDefined();
        expect(session.page).toBeDefined();
    });

    it('should navigate to a url', async () => {
        const session = await launchBrowser(config);
        await navigateTo(session.page, 'http://test.com');
        
        expect(session.page.goto).toHaveBeenCalledWith('http://test.com', expect.any(Object));
        expect(session.page.waitForTimeout).toHaveBeenCalled();
    });

    it('should get page content', async () => {
        const session = await launchBrowser(config);
        const content = await getPageContent(session.page);
        
        expect(content.url).toBe('http://test.com');
        expect(content.title).toBe('Test Title');
        expect(content.html).toBe('<html>Test Content</html>');
    });

    it('should close the browser', async () => {
        const session = await launchBrowser(config);
        await closeBrowser(session.browser);
        
        expect(session.browser.close).toHaveBeenCalled();
    });
});
