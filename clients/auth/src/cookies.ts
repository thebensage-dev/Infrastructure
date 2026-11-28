// Cookie names, shared by the server code and the proxy (which can't import server-only code).
// Each app has its own prefix, so signing in to one app never overwrites another's cookies.

export type CookieNames = {
  /** The encrypted session: name, email, authentik groups (and tokens, when kept). */
  session: string;
  /** The sign-in in progress: state, PKCE verifier and where to go back to. 15 minutes. */
  login: string;
  /**
   * Set while the automatic sign-in check is paused: for a few minutes after a check found no
   * authentik session, so a signed-out visitor isn't sent round on every page.
   */
  ssoChecked: string;
  /**
   * Set after a sign-in. The automatic check only runs in a browser that has it, so new
   * visitors and AI agents get the page itself, never a hop to authentik.
   */
  returning: string;
};

export const cookieNames = (prefix: string): CookieNames => ({
  session: `${prefix}_session`,
  login: `${prefix}_login`,
  ssoChecked: `${prefix}_sso_checked`,
  returning: `${prefix}_returning`,
});

/** One cookie's value from a Cookie header (for code that only has the request's headers). */
export function cookieFrom(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}
