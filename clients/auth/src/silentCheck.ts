import { cookieNames } from "./cookies.ts";

// The automatic sign-in check's decision, without Next (so it can be tested on its own). The
// proxy (`./proxy.ts`) feeds it the request.

export type PageRequest = {
  pathname: string;
  search: string;
  method: string;
  headers: { get(name: string): string | null; has(name: string): boolean };
  cookies: { has(name: string): boolean };
  /** A search engine, link preview or other bot (from the user agent). */
  isBot: boolean;
};

/** Which signed-out browsers the silent check runs for (see createAuth's `silentSignOn`). */
export type SilentSignOn = "returning" | "always" | "off";

export type SingleSignOnOptions = {
  /** The same prefix as the app's createAuth. */
  cookiePrefix: string;
  /** The same as createAuth's `silentSignOn`. Default "returning". */
  mode?: SilentSignOn;
  /** The env var holding this app's public URL. Default "APP_URL". */
  appUrlEnv?: string;
  /** More path prefixes that aren't pages, such as "/cv/". */
  skip?: string[];
};

/** Paths that are never pages: sign-in and preview routes, files and robots/sitemap. */
const NOT_PAGES = [
  "/auth/",
  "/preview",
  "/icon.svg",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
];

/** True for a real page load in a browser: not a prefetch, an RSC request or a bot. */
export function isPageLoad(request: PageRequest, skip: readonly string[] = []): boolean {
  const { headers } = request;
  return (
    ![...NOT_PAGES, ...skip].some((prefix) => request.pathname.startsWith(prefix)) &&
    request.method === "GET" &&
    headers.get("sec-fetch-mode") === "navigate" &&
    headers.get("sec-fetch-dest") === "document" &&
    !headers.has("next-router-prefetch") &&
    !headers.has("rsc") &&
    // Search engines and link previews must get the page itself, not a hop to authentik (whose
    // robots.txt disallows everything, so the page would never be indexed).
    !request.isBot
  );
}

/**
 * Where to send a signed-out page view from a browser that has signed in here before (the
 * silent check), or null to serve the page as it is.
 */
export function silentCheckUrl(
  request: PageRequest,
  options: SingleSignOnOptions,
  fallbackOrigin: string,
): URL | null {
  const names = cookieNames(options.cookiePrefix);
  const { cookies } = request;
  if (
    !process.env.OIDC_ISSUER_URL ||
    options.mode === "off" ||
    ((options.mode ?? "returning") === "returning" && !cookies.has(names.returning)) ||
    cookies.has(names.session) ||
    cookies.has(names.ssoChecked) ||
    !isPageLoad(request, options.skip)
  ) {
    return null;
  }
  // From the app's URL: behind the proxy, the request's own URL can be the container's (and http).
  const login = new URL(
    "/auth/login",
    process.env[options.appUrlEnv ?? "APP_URL"] || fallbackOrigin,
  );
  login.searchParams.set("silent", "1");
  login.searchParams.set("returnTo", request.pathname + request.search);
  return login;
}
