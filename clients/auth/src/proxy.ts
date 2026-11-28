import { NextResponse, userAgent, type NextRequest } from "next/server";
import { silentCheckUrl, type SingleSignOnOptions } from "./silentCheck.ts";

// Automatic single sign-on, for the app's src/proxy.ts (it runs before every page, so it can't
// import the server code). A signed-out page view from a browser that has signed in here before
// first goes through a silent check with authentik (/auth/login?silent=1). Someone still signed
// in to authentik comes back signed in; everyone else comes back to the same page, signed out,
// with no error. It only runs for real page loads in a browser (Sec-Fetch headers), never for
// new visitors, bots, link previews, prefetches, Server Actions or uptime checks, and pauses
// after each check.

/** A redirect into the silent check, or null to serve the page as it is. */
export function singleSignOn(
  request: NextRequest,
  options: SingleSignOnOptions,
): NextResponse | null {
  const { nextUrl } = request;
  const url = silentCheckUrl(
    {
      pathname: nextUrl.pathname,
      search: nextUrl.search,
      method: request.method,
      headers: request.headers,
      cookies: request.cookies,
      isBot: userAgent(request).isBot,
    },
    options,
    nextUrl.origin,
  );
  return url && NextResponse.redirect(url);
}
