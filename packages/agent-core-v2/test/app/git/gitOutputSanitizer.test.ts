/**
 * Scenario: sanitize git process output before it reaches wire callers.
 * Responsibilities: redact credentials, tokens, sensitive query values, and
 * workspace paths while bounding output. Wiring: pure sanitizer only. Run:
 * pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/git/gitOutputSanitizer.test.ts
 */

import { describe, expect, it } from 'vitest';

import { sanitizeGitOutput } from '#/app/git/gitOutputSanitizer';

describe('sanitizeGitOutput', () => {
  it('redacts URL user info and sensitive query values', () => {
    expect(
      sanitizeGitOutput(
        'https://alice:secret@example.test/repo?access_token=abc123&key=private',
      ),
    ).toBe('https://[redacted]@example.test/repo?access_token=[redacted]&key=[redacted]');
  });

  it('redacts authorization values and common provider tokens', () => {
    const value = sanitizeGitOutput(
      'Authorization: Bearer secret-value ghp_123456789012345678901234567890 glpat-1234567890123456',
    );

    expect(value).toBe(
      'Authorization: [redacted] [redacted-token] [redacted-token]',
    );
  });

  it('replaces the workspace path and bounds long output', () => {
    const value = sanitizeGitOutput(`/private/work/repo ${'x'.repeat(9_000)}`, '/private/work/repo');

    expect(value.startsWith('[workspace] ')).toBe(true);
    expect(value.length).toBeLessThanOrEqual(8_193);
  });
});
