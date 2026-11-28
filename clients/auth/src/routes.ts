import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { AccessDenied, type Auth } from "./auth.ts";

// The four /auth routes every app has. In the app:
//
//   // src/app/auth/login/route.ts
//   export const { GET } = authRoutes(auth).login;
//
// and the same for callback, logout (POST) and frontchannel-logout.

export function authRoutes(auth: Auth) {
  const { home, loginPage, name } = auth.options;

  /**
   * GET /auth/login?returnTo=… sends the browser to authentik. With silent=1 (from the proxy)
   * it's the automatic single sign-on check, which never shows authentik's page. If authentik
   * can't be reached, the app keeps working signed out: a silent check goes back to the page,
   * a click on Sign in says it failed.
   */
  async function login(request: NextRequest) {
    const params = request.nextUrl.searchParams;
    if (!auth.configured()) redirect(home);
    const silent = params.get("silent") === "1";
    const returnTo = params.get("returnTo") ?? home;
    let url: URL;
    try {
      url = await auth.beginLogin(returnTo, { silent });
    } catch (err) {
      console.error("Couldn't reach authentik:", err);
      redirect(silent ? auth.safeReturnTo(returnTo) : `${loginPage}?signin=failed`);
    }
    redirect(url.href);
  }

  /** GET /auth/callback: authentik's redirect after a sign-in or a silent check. */
  async function callback(request: NextRequest) {
    let next: string;
    try {
      next = await auth.completeLogin(request.nextUrl.search);
    } catch (err) {
      if (err instanceof AccessDenied) redirect(`${loginPage}?signin=denied`);
      // A silent check whose login cookie went missing: just carry on signed out.
      if (request.nextUrl.searchParams.get("error") === "login_required") redirect(home);
      console.error("Sign-in failed:", err);
      redirect(`${loginPage}?signin=failed`);
    }
    redirect(next);
  }

  /**
   * POST /auth/logout, from a sign-out form (POST only, so a link or image can't sign someone
   * out). Not a redirect: a CSP `form-action 'self'` also covers where a form submission is
   * redirected, so the browser would block a redirect to authentik. A tiny page that moves on by
   * itself is a new navigation, which the CSP allows.
   */
  async function logout() {
    const next = await auth.signOut();
    const href = next.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}"><title>Signing out</title></head><body><p>Signing out of every app… <a href="${href}">Continue</a></p></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }

  /**
   * GET /auth/frontchannel-logout?iss=…&sid=…: runs in a hidden frame on authentik's sign-out
   * page, so this one route may be framed by authentik (keep it out of the app's frame ban).
   */
  async function frontchannelLogout(request: NextRequest) {
    const params = request.nextUrl.searchParams;
    const done = await auth.frontchannelLogout(params.get("iss"), params.get("sid"));
    return new Response(done ? `Signed out of ${name}.` : "Not for this app.", {
      status: done ? 200 : 400,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `frame-ancestors ${auth.issuerOrigin() ?? "'none'"}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return {
    login: { GET: login },
    callback: { GET: callback },
    logout: { POST: logout },
    frontchannelLogout: { GET: frontchannelLogout },
  };
}
