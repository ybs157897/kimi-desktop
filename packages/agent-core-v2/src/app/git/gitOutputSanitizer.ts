/**
 * `git` domain — sanitizes bounded command output before it reaches wire-facing callers.
 */

const MAX_GIT_OUTPUT_LENGTH = 8_192;

export function sanitizeGitOutput(value: string, workspacePath?: string): string {
  let sanitized = value;
  if (workspacePath !== undefined && workspacePath !== '') {
    sanitized = sanitized.replaceAll(workspacePath, '[workspace]');
  }
  sanitized = sanitized.replaceAll(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/giu,
    '$1[redacted]@',
  );
  sanitized = sanitized.replaceAll(
    /([?&](?:access_token|auth|authorization|key|password|secret|token)=)[^&#\s]*/giu,
    '$1[redacted]',
  );
  sanitized = sanitized.replaceAll(
    /\b(authorization\s*[:=]\s*)(?:basic|bearer)?\s*[^\s,;]+/giu,
    '$1[redacted]',
  );
  sanitized = sanitized.replaceAll(
    /\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/gu,
    '[redacted-token]',
  );
  return sanitized.length > MAX_GIT_OUTPUT_LENGTH
    ? `${sanitized.slice(0, MAX_GIT_OUTPUT_LENGTH)}…`
    : sanitized;
}
