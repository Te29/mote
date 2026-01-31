import { describe, it, expect } from 'vitest';
import type { PageState, ElementInfo, Action } from '../../src/types/index.js';
import {
    isModalLikeElement,
    extractNotableChanges,
    formatNotableChanges,
    buildDriftAnalysisPrompt,
    type NotableChanges,
} from '../../src/prompt.js';

describe('Drift Analysis Helpers', () => {
    // Helper to create a basic element
    const makeElement = (
        index: number,
        tag: string,
        text: string,
        attributes: Record<string, string> = {}
    ): ElementInfo => ({
        index,
        tag,
        text,
        selector: `#el-${index}`,
        attributes,
    });

    // Helper to create a basic page state
    const makePageState = (
        overrides: Partial<PageState> = {},
        elements: ElementInfo[] = []
    ): PageState => ({
        url: 'https://example.com',
        title: 'Example Page',
        markdown: 'Some content',
        elements: elements.length > 0 ? elements : [
            makeElement(1, 'button', 'Submit'),
            makeElement(2, 'input', 'Email'),
        ],
        ...overrides,
    });

    describe('isModalLikeElement()', () => {
        it('should detect dialog tag', () => {
            const el = makeElement(1, 'dialog', 'Modal Content');
            expect(isModalLikeElement(el)).toBe(true);
        });

        it('should detect role="dialog"', () => {
            const el = makeElement(1, 'div', 'Modal', { role: 'dialog' });
            expect(isModalLikeElement(el)).toBe(true);
        });

        it('should detect role="alertdialog"', () => {
            const el = makeElement(1, 'div', 'Alert', { role: 'alertdialog' });
            expect(isModalLikeElement(el)).toBe(true);
        });

        it('should detect aria-modal="true"', () => {
            const el = makeElement(1, 'div', 'Modal', { 'aria-modal': 'true' });
            expect(isModalLikeElement(el)).toBe(true);
        });

        it('should detect .modal class', () => {
            const el = makeElement(1, 'div', 'Modal', { class: 'my-modal-container' });
            expect(isModalLikeElement(el)).toBe(true);
        });

        it('should detect .overlay class', () => {
            const el = makeElement(1, 'div', 'Overlay', { class: 'page-overlay dark' });
            expect(isModalLikeElement(el)).toBe(true);
        });

        it('should detect .popup class', () => {
            const el = makeElement(1, 'div', 'Popup', { class: 'notification-popup' });
            expect(isModalLikeElement(el)).toBe(true);
        });

        it('should detect .lightbox class', () => {
            const el = makeElement(1, 'div', 'Image', { class: 'image-lightbox' });
            expect(isModalLikeElement(el)).toBe(true);
        });

        it('should NOT detect regular button', () => {
            const el = makeElement(1, 'button', 'Submit', { class: 'btn-primary' });
            expect(isModalLikeElement(el)).toBe(false);
        });

        it('should NOT detect regular div', () => {
            const el = makeElement(1, 'div', 'Content', { class: 'container' });
            expect(isModalLikeElement(el)).toBe(false);
        });

        it('should be case-insensitive for tag', () => {
            const el = makeElement(1, 'DIALOG', 'Modal');
            expect(isModalLikeElement(el)).toBe(true);
        });

        it('should be case-insensitive for class', () => {
            const el = makeElement(1, 'div', 'Modal', { class: 'MyModal' });
            expect(isModalLikeElement(el)).toBe(true);
        });
    });

    describe('extractNotableChanges()', () => {
        it('should detect URL change', () => {
            const expected = makePageState({ url: 'https://example.com/page1' });
            const current = makePageState({ url: 'https://example.com/page2' });

            const changes = extractNotableChanges(expected, current, '1');

            expect(changes.urlChanged).toBe(true);
            expect(changes.expectedUrl).toBe('https://example.com/page1');
            expect(changes.currentUrl).toBe('https://example.com/page2');
        });

        it('should NOT report URL change when URLs match', () => {
            const expected = makePageState({ url: 'https://example.com' });
            const current = makePageState({ url: 'https://example.com' });

            const changes = extractNotableChanges(expected, current, '1');

            expect(changes.urlChanged).toBe(false);
            expect(changes.expectedUrl).toBeUndefined();
            expect(changes.currentUrl).toBeUndefined();
        });

        it('should detect title change', () => {
            const expected = makePageState({ title: 'Page 1' });
            const current = makePageState({ title: 'Page 2' });

            const changes = extractNotableChanges(expected, current, '1');

            expect(changes.titleChanged).toBe(true);
            expect(changes.expectedTitle).toBe('Page 1');
            expect(changes.currentTitle).toBe('Page 2');
        });

        it('should detect new modal appearing', () => {
            const expected = makePageState({}, [
                makeElement(1, 'button', 'Submit'),
            ]);
            const current = makePageState({}, [
                makeElement(1, 'button', 'Submit'),
                makeElement(2, 'div', 'Please confirm', { role: 'dialog' }),
            ]);

            const changes = extractNotableChanges(expected, current, '1');

            expect(changes.modalDetected).toBe(true);
            expect(changes.modalElements).toHaveLength(1);
            expect(changes.modalElements[0]).toContain('Please confirm');
        });

        it('should NOT report modal if it existed before', () => {
            const modalEl = makeElement(2, 'div', 'Existing modal', { role: 'dialog' });
            const expected = makePageState({}, [
                makeElement(1, 'button', 'Submit'),
                modalEl,
            ]);
            const current = makePageState({}, [
                makeElement(1, 'button', 'Submit'),
                modalEl,
            ]);

            const changes = extractNotableChanges(expected, current, '1');

            expect(changes.modalDetected).toBe(false);
            expect(changes.modalElements).toHaveLength(0);
        });

        it('should detect target element missing', () => {
            const expected = makePageState({}, [
                makeElement(1, 'button', 'Submit'),
                makeElement(2, 'input', 'Email'),
            ]);
            const current = makePageState({}, [
                makeElement(1, 'button', 'Submit'),
                // Element 2 is gone
            ]);

            const changes = extractNotableChanges(expected, current, '2');

            expect(changes.targetElementMissing).toBe(true);
        });

        it('should NOT report target missing if it exists', () => {
            const expected = makePageState({}, [
                makeElement(1, 'button', 'Submit'),
            ]);
            const current = makePageState({}, [
                makeElement(1, 'button', 'Submit'),
            ]);

            const changes = extractNotableChanges(expected, current, '1');

            expect(changes.targetElementMissing).toBe(false);
        });

        it('should calculate element count delta', () => {
            const expected = makePageState({}, [
                makeElement(1, 'button', 'A'),
                makeElement(2, 'button', 'B'),
            ]);
            const current = makePageState({}, [
                makeElement(1, 'button', 'A'),
                makeElement(2, 'button', 'B'),
                makeElement(3, 'button', 'C'),
                makeElement(4, 'button', 'D'),
            ]);

            const changes = extractNotableChanges(expected, current, '1');

            expect(changes.elementCountDelta).toBe(2);
        });

        it('should detect captcha appearing', () => {
            const expected = makePageState({ captcha: undefined });
            const current = makePageState({ captcha: { detected: true, type: 'recaptcha' } });

            const changes = extractNotableChanges(expected, current, '1');

            expect(changes.captchaAppeared).toBe(true);
        });

        it('should NOT report captcha if it was already there', () => {
            const expected = makePageState({ captcha: { detected: true, type: 'recaptcha' } });
            const current = makePageState({ captcha: { detected: true, type: 'recaptcha' } });

            const changes = extractNotableChanges(expected, current, '1');

            expect(changes.captchaAppeared).toBe(false);
        });

        it('should handle empty elementId gracefully', () => {
            const expected = makePageState();
            const current = makePageState();

            // Empty string should result in targetElementMissing = true (NaN !== any index)
            const changes = extractNotableChanges(expected, current, '');

            expect(changes.targetElementMissing).toBe(true);
        });
    });

    describe('formatNotableChanges()', () => {
        it('should format URL change', () => {
            const changes: NotableChanges = {
                urlChanged: true,
                expectedUrl: 'https://a.com',
                currentUrl: 'https://b.com',
                titleChanged: false,
                modalDetected: false,
                modalElements: [],
                targetElementMissing: false,
                elementCountDelta: 0,
                captchaAppeared: false,
            };

            const result = formatNotableChanges(changes);

            expect(result).toContain('URL CHANGED');
            expect(result).toContain('https://a.com');
            expect(result).toContain('https://b.com');
        });

        it('should format title change', () => {
            const changes: NotableChanges = {
                urlChanged: false,
                titleChanged: true,
                expectedTitle: 'Old Title',
                currentTitle: 'New Title',
                modalDetected: false,
                modalElements: [],
                targetElementMissing: false,
                elementCountDelta: 0,
                captchaAppeared: false,
            };

            const result = formatNotableChanges(changes);

            expect(result).toContain('TITLE CHANGED');
            expect(result).toContain('Old Title');
            expect(result).toContain('New Title');
        });

        it('should format modal detection', () => {
            const changes: NotableChanges = {
                urlChanged: false,
                titleChanged: false,
                modalDetected: true,
                modalElements: ['[5] div: "Confirm action"'],
                targetElementMissing: false,
                elementCountDelta: 0,
                captchaAppeared: false,
            };

            const result = formatNotableChanges(changes);

            expect(result).toContain('MODAL/DIALOG DETECTED');
            expect(result).toContain('Confirm action');
        });

        it('should format captcha appearance', () => {
            const changes: NotableChanges = {
                urlChanged: false,
                titleChanged: false,
                modalDetected: false,
                modalElements: [],
                targetElementMissing: false,
                elementCountDelta: 0,
                captchaAppeared: true,
            };

            const result = formatNotableChanges(changes);

            expect(result).toContain('CAPTCHA APPEARED');
        });

        it('should format target element missing', () => {
            const changes: NotableChanges = {
                urlChanged: false,
                titleChanged: false,
                modalDetected: false,
                modalElements: [],
                targetElementMissing: true,
                elementCountDelta: 0,
                captchaAppeared: false,
            };

            const result = formatNotableChanges(changes);

            expect(result).toContain('TARGET ELEMENT MISSING');
        });

        it('should format significant element count increase', () => {
            const changes: NotableChanges = {
                urlChanged: false,
                titleChanged: false,
                modalDetected: false,
                modalElements: [],
                targetElementMissing: false,
                elementCountDelta: 15,
                captchaAppeared: false,
            };

            const result = formatNotableChanges(changes);

            expect(result).toContain('Element count increased by 15');
        });

        it('should format significant element count decrease', () => {
            const changes: NotableChanges = {
                urlChanged: false,
                titleChanged: false,
                modalDetected: false,
                modalElements: [],
                targetElementMissing: false,
                elementCountDelta: -20,
                captchaAppeared: false,
            };

            const result = formatNotableChanges(changes);

            expect(result).toContain('Element count decreased by 20');
        });

        it('should NOT report small element count changes', () => {
            const changes: NotableChanges = {
                urlChanged: false,
                titleChanged: false,
                modalDetected: false,
                modalElements: [],
                targetElementMissing: false,
                elementCountDelta: 5, // Less than threshold of 10
                captchaAppeared: false,
            };

            const result = formatNotableChanges(changes);

            expect(result).not.toContain('Element count');
        });

        it('should return "no changes" message when nothing changed', () => {
            const changes: NotableChanges = {
                urlChanged: false,
                titleChanged: false,
                modalDetected: false,
                modalElements: [],
                targetElementMissing: false,
                elementCountDelta: 0,
                captchaAppeared: false,
            };

            const result = formatNotableChanges(changes);

            expect(result).toContain('No significant page-level changes');
        });

        it('should combine multiple changes', () => {
            const changes: NotableChanges = {
                urlChanged: true,
                expectedUrl: 'https://a.com',
                currentUrl: 'https://b.com',
                titleChanged: true,
                expectedTitle: 'Old',
                currentTitle: 'New',
                modalDetected: true,
                modalElements: ['[1] dialog: "Confirm"'],
                targetElementMissing: false,
                elementCountDelta: 0,
                captchaAppeared: false,
            };

            const result = formatNotableChanges(changes);

            expect(result).toContain('URL CHANGED');
            expect(result).toContain('TITLE CHANGED');
            expect(result).toContain('MODAL/DIALOG DETECTED');
        });
    });

    describe('buildDriftAnalysisPrompt()', () => {
        const mockAction: Action = {
            type: 'click',
            elementId: '1',
            reason: 'Click submit button',
        };

        it('should include PAGE CHANGES DETECTED section', () => {
            const expected = makePageState({ url: 'https://a.com' });
            const current = makePageState({ url: 'https://b.com' });

            const { userPrompt } = buildDriftAnalysisPrompt(
                expected,
                current,
                mockAction,
                '[1] button: "Submit"'
            );

            expect(userPrompt).toContain('PAGE CHANGES DETECTED');
            expect(userPrompt).toContain('URL CHANGED');
        });

        it('should include EXPECTED TARGET CONTEXT section', () => {
            const expected = makePageState();
            const current = makePageState();
            const elementContext = '[1] button: "Submit" class="btn-primary"';

            const { userPrompt } = buildDriftAnalysisPrompt(
                expected,
                current,
                mockAction,
                elementContext
            );

            expect(userPrompt).toContain('EXPECTED TARGET CONTEXT');
            expect(userPrompt).toContain(elementContext);
        });

        it('should include CURRENT PAGE STATE section', () => {
            const expected = makePageState();
            const current = makePageState({}, [
                makeElement(1, 'button', 'Submit'),
                makeElement(2, 'a', 'Learn more'),
            ]);

            const { userPrompt } = buildDriftAnalysisPrompt(
                expected,
                current,
                mockAction,
                '[1] button: "Submit"'
            );

            expect(userPrompt).toContain('CURRENT PAGE STATE');
            expect(userPrompt).toContain('Submit');
            expect(userPrompt).toContain('Learn more');
        });

        it('should include planned action details', () => {
            const expected = makePageState();
            const current = makePageState();

            const { userPrompt } = buildDriftAnalysisPrompt(
                expected,
                current,
                mockAction,
                '[1] button: "Submit"'
            );

            expect(userPrompt).toContain('PLANNED ACTION');
            expect(userPrompt).toContain('click');
            expect(userPrompt).toContain('1');
            expect(userPrompt).toContain('Click submit button');
        });

        it('should have proper system prompt with decision rules', () => {
            const expected = makePageState();
            const current = makePageState();

            const { systemPrompt } = buildDriftAnalysisPrompt(
                expected,
                current,
                mockAction,
                '[1] button: "Submit"'
            );

            expect(systemPrompt).toContain('can_proceed');
            expect(systemPrompt).toContain('cannot_complete');
            expect(systemPrompt).toContain('adaptedAction');
            expect(systemPrompt).toContain('ADAPTATION GUIDELINES');
        });

        it('should mention modal handling in system prompt', () => {
            const expected = makePageState();
            const current = makePageState();

            const { systemPrompt } = buildDriftAnalysisPrompt(
                expected,
                current,
                mockAction,
                '[1] button: "Submit"'
            );

            expect(systemPrompt).toContain('modal');
        });

        it('should handle action without elementId', () => {
            const expected = makePageState();
            const current = makePageState();
            const scrollAction: Action = {
                type: 'scroll',
                text: 'down',
                reason: 'Scroll to see more content',
            };

            // Should not throw
            const { userPrompt } = buildDriftAnalysisPrompt(
                expected,
                current,
                scrollAction,
                'N/A - scroll action'
            );

            expect(userPrompt).toContain('scroll');
        });
    });
});
