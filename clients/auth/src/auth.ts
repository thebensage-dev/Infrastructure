import { cookies } from "next/headers";
import * as oidc from "openid-client";
import { cookieFrom, cookieNames } from "./cookies.ts";
import { seal, unseal } from "./seal.ts";
import type { SilentSignOn } from "./silentCheck.ts";

// Sign-in through authentik for a Next.js app: OpenID Connect, authorization code + PKCE.
//
// - The session is an encrypted cookie (no session table) with the person's name, email,
//   authentik groups and session id. With `keepTokens` it also holds authentik's access and
//   refresh tokens, for an app that calls an API as the person.
// - Single sign-on: the proxy (`./proxy`) sends a signed-out page view through a silent check
//   (prompt=none). authentik answers at once, with a code when it has a session and with
//   error=login_required when it hasn't; either way the visitor lands back on the same page.
// - Single logout: signing out goes through authentik's shared "Sign out" flow, which loads every
//   app's front-channel logout page in a hidden frame.
//
// What someone may do comes from their groups, which each app checks itself.

export type AuthOptions = {
  /** The app's slug in authentik's shared flows (`?app=`), such as "portfolio". */
  app: string;
  /** Prefix for this app's cookies, such as "pf" (pf_session, pf_login...). */
  cookiePrefix: string;
  /** Named in the front-channel logout's answer: "Signed out of <name>." */
  name: string;
  /** Where to go when there's nowhere better (a bad or missing returnTo). Default "/". */
  home?: string;
  /** Where a failed or refused sign-in is sent, with `?signin=failed|denied`. Default `home`. */
  loginPage?: string;
  /** The env var holding this app's public URL. Default "APP_URL". */
  appUrlEnv?: string;
  /** Narrows the paths a sign-in may return to (always same-site paths only). */
  allowReturn?: (path: string) => boolean;
  /**
   * The proxy's automatic sign-in check (its `mode` must match): "returning" (the default) only
   * checks browsers that have signed in here before, so a sign-in sets a one-year `_returning`
   * cookie; "always" checks every signed-out browser (no extra cookie); "off" for an app with no
   * public pages.
   */
  silentSignOn?: SilentSignOn;
  /** Keep authentik's access and refresh tokens, for `accessToken()`. */
  keepTokens?: boolean;
  /** Runs after authentik signs someone in, before the session is set. Throw AccessDenied to refuse. */
  onSignIn?: (session: Session) => Promise<void> | void;
};

/** The signed-in person. */
export type Session = {
  sub: string;
  name: string;
  email: string;
  /** Their authentik groups, from the ID token (and from every refresh, with keepTokens). */
  groups: string[];
  /** authentik's session id, matched by front-channel logout. */
  sid?: string;
};

type TokenSession = Session & {
  accessToken?: string;
  refreshToken?: string;
  /** When the access token expires, in seconds since 1970. */
  accessExpires?: number;
  /** When the session itself ends, in seconds since 1970 (the JWT's exp). */
  exp?: number;
};

/** Thrown by `onSignIn` to refuse someone authentik let in (the app's own group rules). */
export class AccessDenied extends Error {
  constructor(message = "This account has no access here.") {
    super(message);
    this.name = "AccessDenied";
  }
}

type AuthEnv = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  appUrl: string;
  secret: string;
  internalUrl?: string;
};

const SESSION_HOURS = 8;
/** How long to wait before checking again after a silent check found no authentik session. */
const SSO_RECHECK_MINUTES = 10;
const RETURNING_DAYS = 365;
/** Refresh this long before the access token runs out, so it can't expire mid-request. */
const REFRESH_MARGIN_SECONDS = 60;
/** authentik's answers to prompt=none that just mean "not signed in here". */
const SILENT_MISSES = new Set(["login_required", "consent_required", "interaction_required"]);

const trimSlash = (value: string) => value.replace(/\/+$/, "");
const nowSeconds = () => Math.floor(Date.now() / 1000);
const groupsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((g): g is string => typeof g === "string") : [];

export function createAuth(options: AuthOptions) {
  const names = cookieNames(options.cookiePrefix);
  const home = options.home ?? "/";
  const loginPage = options.loginPage ?? home;

  function readEnv(): AuthEnv | null {
    const env = process.env;
    const appUrl = env[options.appUrlEnv ?? "APP_URL"];
    const { OIDC_ISSUER_URL: issuer, OIDC_CLIENT_ID: clientId } = env;
    const { OIDC_CLIENT_SECRET: clientSecret, AUTH_SECRET: secret } = env;
    if (!issuer || !clientId || !clientSecret || !appUrl || !secret) return null;
    return {
      // Exactly as given: authentik's issuer ends in a slash and must match character for character.
      issuer,
      clientId,
      clientSecret,
      appUrl: trimSlash(appUrl),
      secret,
      internalUrl: env.OIDC_INTERNAL_URL ? trimSlash(env.OIDC_INTERNAL_URL) : undefined,
    };
  }

  function requireEnv(): AuthEnv {
    const env = readEnv();
    if (!env) throw new Error("Sign-in isn't configured (see .env.example).");
    return env;
  }

  const cookieOptions = (env: AuthEnv, maxAgeSeconds: number) => ({
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.appUrl.startsWith("https://"),
    path: "/",
    maxAge: maxAgeSeconds,
  });

  /** One of authentik's shared flows (from the blueprint), opened for this app or another. */
  const flowUrl = (env: AuthEnv, flow: string, app = options.app) =>
    new URL(`/if/flow/${flow}/?app=${encodeURIComponent(app)}`, env.issuer).href;

  let configPromise: Promise<oidc.Configuration> | undefined;

  /**
   * Discovers authentik once per process. With OIDC_INTERNAL_URL (the local Docker stack),
   * server-to-server calls go to that origin, with the public host as X-Forwarded-Host so
   * authentik's issuer still matches. The browser always uses the public URL.
   */
  function getConfig(env: AuthEnv): Promise<oidc.Configuration> {
    configPromise ??= (async () => {
      const publicUrl = new URL(env.issuer);
      const fetchVia: oidc.CustomFetch = (url, init) => {
        // openid-client's body type is a little wider than the DOM's; it only sends what fetch accepts.
        const request = init as RequestInit;
        const target = new URL(url);
        if (!env.internalUrl || target.origin !== publicUrl.origin) return fetch(url, request);
        const internal = new URL(env.internalUrl);
        target.protocol = internal.protocol;
        target.host = internal.host;
        const headers = new Headers(request.headers);
        headers.set("X-Forwarded-Host", publicUrl.host);
        headers.set("X-Forwarded-Proto", publicUrl.protocol.replace(":", ""));
        return fetch(target, { ...request, headers });
      };
      const insecure = env.issuer.startsWith("http://") ? [oidc.allowInsecureRequests] : [];
      const config = await oidc.discovery(
        new URL(env.issuer),
        env.clientId,
        env.clientSecret,
        undefined,
        { [oidc.customFetch]: fetchVia, execute: insecure },
      );
      config[oidc.customFetch] = fetchVia;
      return config;
    })().catch((err) => {
      configPromise = undefined;
      throw err;
    });
    return configPromise;
  }

  /** Only same-site paths (and the app's own rule), so the login can't redirect elsewhere. */
  function safeReturnTo(value: string | null | undefined): string {
    const ok =
      !!value &&
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("\\") &&
      (options.allowReturn?.(value) ?? true);
    return ok ? value : home;
  }

  function tokenFields(tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers) {
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpires: nowSeconds() + (tokens.expiresIn() ?? 300),
    };
  }

  async function readSession(token: string | undefined, env: AuthEnv) {
    const payload = await unseal(token, env.secret);
    if (typeof payload?.sub !== "string") return null;
    const session: TokenSession = {
      sub: payload.sub,
      name: String(payload.name ?? ""),
      email: String(payload.email ?? ""),
      groups: groupsOf(payload.groups),
      sid: typeof payload.sid === "string" ? payload.sid : undefined,
      exp: payload.exp,
    };
    if (options.keepTokens) {
      if (typeof payload.accessToken !== "string") return null;
      session.accessToken = payload.accessToken;
      session.refreshToken =
        typeof payload.refreshToken === "string" ? payload.refreshToken : undefined;
      session.accessExpires = Number(payload.accessExpires ?? 0);
      // An expired access token with no way to refresh it can't call anything: not a session.
      if (!session.refreshToken && session.accessExpires <= nowSeconds()) return null;
    }
    return session;
  }

  const publicSession = ({ sub, name, email, groups, sid }: TokenSession): Session => ({
    sub,
    name,
    email,
    groups,
    sid,
  });

  /** True when the OIDC variables are set, so a Sign in button can work. */
  function configured(): boolean {
    return readEnv() !== null;
  }

  /** authentik's "Your account" page: name, email and password. */
  function accountUrl(): string | null {
    const env = readEnv();
    return env ? flowUrl(env, "account") : null;
  }

  /** authentik's shared "Request access" page with this app (or `app`) ticked. */
  function requestAccessUrl(app?: string): string | null {
    const env = readEnv();
    return env ? flowUrl(env, "request-access", app) : null;
  }

  /**
   * Starts a sign-in: remembers state and the PKCE verifier, returns authentik's URL. A silent
   * one (prompt=none) never shows a page: authentik sends the browser straight back either way.
   */
  async function beginLogin(returnTo: string, { silent = false } = {}): Promise<URL> {
    const env = requireEnv();
    const jar = await cookies();
    // Pauses the automatic check. Set first: if authentik can't be reached, the visitor still
    // gets the page.
    if (silent) jar.set(names.ssoChecked, "1", cookieOptions(env, SSO_RECHECK_MINUTES * 60));
    const config = await getConfig(env);
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    jar.set(
      names.login,
      await seal({ verifier, state, returnTo: safeReturnTo(returnTo), silent }, "15m", env.secret),
      cookieOptions(env, 15 * 60),
    );
    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: `${env.appUrl}/auth/callback`,
      // offline_access: a refresh token, so calls keep working after the access token expires.
      scope: options.keepTokens ? "openid profile email offline_access" : "openid profile email",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      ...(silent && { prompt: "none" }),
    });
  }

  /** Finishes a sign-in from authentik's redirect. Returns where to send the person next. */
  async function completeLogin(search: string): Promise<string> {
    const env = requireEnv();
    const jar = await cookies();
    const pending = await unseal(jar.get(names.login)?.value, env.secret);
    jar.delete(names.login);
    if (typeof pending?.verifier !== "string" || typeof pending.state !== "string") {
      throw new Error("The sign-in expired. Please try again.");
    }

    const returnTo = safeReturnTo(typeof pending.returnTo === "string" ? pending.returnTo : null);
    // A silent check that found no authentik session: carry on signed out, with no error.
    const error = new URLSearchParams(search).get("error");
    if (pending.silent === true && error && SILENT_MISSES.has(error)) return returnTo;

    const config = await getConfig(env);
    // Rebuilt from the app's URL: behind the proxy, the request's own URL is the container's.
    const tokens = await oidc.authorizationCodeGrant(
      config,
      new URL(`${env.appUrl}/auth/callback${search}`),
      { pkceCodeVerifier: pending.verifier, expectedState: pending.state },
    );
    const claims = tokens.claims();
    if (!claims) throw new Error("authentik didn't return an ID token.");

    const session: Session = {
      sub: claims.sub,
      name: String(claims.name ?? claims.preferred_username ?? claims.email ?? "Signed in"),
      email: String(claims.email ?? ""),
      groups: groupsOf(claims.groups),
      sid: typeof claims.sid === "string" ? claims.sid : undefined,
    };
    await options.onSignIn?.(session);

    jar.set(
      names.session,
      await seal(
        { ...session, ...(options.keepTokens && tokenFields(tokens)) },
        `${SESSION_HOURS}h`,
        env.secret,
      ),
      cookieOptions(env, SESSION_HOURS * 3600),
    );
    if ((options.silentSignOn ?? "returning") === "returning") {
      jar.set(names.returning, "1", cookieOptions(env, RETURNING_DAYS * 86400));
    }
    jar.delete(names.ssoChecked);
    return returnTo;
  }

  /** The signed-in person, or null. Always null when sign-in isn't configured. */
  async function currentSession(): Promise<Session | null> {
    const env = readEnv();
    if (!env) return null;
    const session = await readSession((await cookies()).get(names.session)?.value, env);
    return session && publicSession(session);
  }

  /** The same, from a Cookie header: for code that has the request's headers but no Next context. */
  async function sessionFromHeaders(headers: Headers): Promise<Session | null> {
    const env = readEnv();
    if (!env) return null;
    const session = await readSession(cookieFrom(headers.get("cookie"), names.session), env);
    return session && publicSession(session);
  }

  /**
   * The signed-in person's access token (with `keepTokens`), or null when nobody is signed in.
   * Refreshes it first when it's about to expire, which rewrites the session cookie, so call it
   * only from Server Actions and route handlers. A failed refresh (revoked in authentik, say)
   * signs the person out here.
   */
  async function accessToken(): Promise<string | null> {
    if (!options.keepTokens) throw new Error("accessToken() needs keepTokens: true.");
    const env = readEnv();
    if (!env) return null;
    const jar = await cookies();
    const session = await readSession(jar.get(names.session)?.value, env);
    if (!session?.accessToken) return null;
    if ((session.accessExpires ?? 0) - REFRESH_MARGIN_SECONDS > nowSeconds()) {
      return session.accessToken;
    }
    if (!session.refreshToken) return null;

    try {
      const tokens = await oidc.refreshTokenGrant(await getConfig(env), session.refreshToken);
      const { exp, ...rest } = session;
      const end = exp ?? nowSeconds() + SESSION_HOURS * 3600;
      // A refresh brings the current groups, so an approval shows up within the hour.
      const claims = tokens.claims();
      const refreshed = {
        ...rest,
        ...(claims && { groups: groupsOf(claims.groups) }),
        ...tokenFields(tokens),
      };
      // authentik may not rotate the refresh token; keep the old one then.
      refreshed.refreshToken ??= session.refreshToken;
      jar.set(
        names.session,
        await seal(refreshed, end, env.secret),
        cookieOptions(env, Math.max(0, end - nowSeconds())),
      );
      return refreshed.accessToken;
    } catch {
      jar.delete(names.session);
      return null;
    }
  }

  /**
   * Signs out everywhere (single logout): drops this app's session and returns authentik's
   * "Sign out" page, which ends the authentik session, signs the other apps out through their
   * front-channel logout and sends the person back.
   */
  async function signOut(): Promise<string> {
    (await cookies()).delete(names.session);
    const env = readEnv();
    return env ? flowUrl(env, "sign-out") : home;
  }

  /**
   * Front-channel logout: only for this app's issuer, and only the session from that authentik
   * session (sid) when both know it. Returns false for a request that isn't for this app.
   */
  async function frontchannelLogout(iss: string | null, sid: string | null): Promise<boolean> {
    const env = readEnv();
    if (!env || iss !== env.issuer) return false;
    const jar = await cookies();
    const session = await readSession(jar.get(names.session)?.value, env);
    if (session?.sid && sid && session.sid !== sid) return true;
    jar.delete(names.session);
    return true;
  }

  /** The origin allowed to frame the front-channel logout page (authentik's). */
  function issuerOrigin(): string | null {
    const env = readEnv();
    return env ? new URL(env.issuer).origin : null;
  }

  return {
    options: { ...options, home, loginPage },
    cookies: names,
    configured,
    accountUrl,
    requestAccessUrl,
    safeReturnTo,
    beginLogin,
    completeLogin,
    currentSession,
    sessionFromHeaders,
    accessToken,
    signOut,
    frontchannelLogout,
    issuerOrigin,
  };
}

export type Auth = ReturnType<typeof createAuth>;

/** True when any of `groups` is in `allowed`: the apps' group checks. */
export const inGroup = (groups: readonly string[], allowed: readonly string[]) =>
  groups.some((group) => allowed.includes(group));
