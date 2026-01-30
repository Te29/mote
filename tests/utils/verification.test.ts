
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeVerification } from '../../src/utils/verification.js';
import type { Page } from 'playwright';

describe('Verification Module', () => {
    let mockPage: Page;

    beforeEach(() => {
        mockPage = {
            evaluate: vi.fn(),
        } as unknown as Page;
    });

    it('should return pass when script returns true', async () => {
        (mockPage.evaluate as any).mockResolvedValue(true);

        const result = await executeVerification(mockPage, {
            script: '() => true',
            description: 'Test pass'
        });

        expect(result.passed).toBe(true);
        expect(result.method).toBe('script');
    });

    it('should return fail (strategy: fail) when script returns false', async () => {
        (mockPage.evaluate as any).mockResolvedValue(false);

        const result = await executeVerification(mockPage, {
            script: '() => false',
            description: 'Test fail',
            onFailure: 'fail'
        });

        expect(result.passed).toBe(false);
        expect(result.method).toBe('strategy');
        expect(result.error).toBe('Script returned false');
    });

    it('should return pass (strategy: continue) when script returns false', async () => {
        (mockPage.evaluate as any).mockResolvedValue(false);

        const result = await executeVerification(mockPage, {
            script: '() => false',
            description: 'Test continue',
            onFailure: 'continue'
        });

        expect(result.passed).toBe(true);
        expect(result.method).toBe('strategy');
    });

    it('should fail when script returns non-boolean', async () => {
        (mockPage.evaluate as any).mockResolvedValue('not a boolean');

        const result = await executeVerification(mockPage, {
            script: '() => ""',
            description: 'Test invalid return',
            onFailure: 'fail'
        });

        expect(result.passed).toBe(false);
        expect(result.error).toContain('Verification script must return boolean');
    });
});
