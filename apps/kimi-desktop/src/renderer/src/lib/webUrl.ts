/**
 * Web UI deep-link URL construction (the TUI `/web` equivalent). The web app
 * reads its bearer token from `location.hash` (`#token=…`), so the URL is
 * `origin[/sessions/<id>]#token=…`. Pure — unit-tested in a node environment.
 */

/**
 * Build the web-app URL for the embedded kap-server. `sessionId === null`
 * opens the bare origin; a `token` (when present) rides the hash fragment.
 * The no-session form keeps the trailing slash (`origin/#token=`), matching
 * the TUI's `buildOpenableUrl`.
 */
export function webAppUrl(
  baseUrl: string,
  sessionId: string | null,
  token: string | undefined,
): string {
  const origin = baseUrl.replace(/\/+$/, '');
  if (sessionId === null) {
    if (token === undefined || token === '') return origin;
    return `${origin}/#token=${encodeURIComponent(token)}`;
  }
  const path = `/sessions/${encodeURIComponent(sessionId)}`;
  if (token === undefined || token === '') return `${origin}${path}`;
  return `${origin}${path}#token=${encodeURIComponent(token)}`;
}
