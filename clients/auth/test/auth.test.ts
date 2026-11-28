import assert from "node:assert/strict";
import { test } from "node:test";
import { cookieFrom, cookieNames } from "../src/cookies.ts";
import { isPageLoad, silentCheckUrl, type PageRequest } from "../src/silentCheck.ts";
import { seal, unseal } from "../src/seal.ts";

test("cookie names carry the app's prefix", () => {
  assert.deepEqual(cookieNames("pf"), {
    session: "pf_session",
    login: "pf_login",
    ssoChecked: "pf_sso_checked",
    returning: "pf_returning",
  });
});

test("cookieFrom reads one cookie from a header", () => {
  assert.equal(cookieFrom("a=1; pf_session=x%3Dy; b=2", "pf_session"), "x=y");
  assert.equal(cookieFrom("a=1", "pf_session"), undefined);
  assert.equal(cookieFrom(null, "pf_session"), undefined);
});

test("a sealed cookie opens only with its own secret", async () => {
  const token = await seal({ sub: "1", groups: ["g"] }, "1h", "secret-a");
  assert.equal((await unseal(token, "secret-a"))?.sub, "1");
  assert.equal(await unseal(token, "secret-b"), null);
  assert.equal(await unseal(token + "x", "secret-a"), null);
  assert.equal(await unseal(undefined, "secret-a"), null);
});

test("an expired cookie doesn't open", async () => {
  const token = await seal({ sub: "1" }, Math.floor(Date.now() / 1000) - 10, "s");
  assert.equal(await unseal(token, "s"), null);
});

const browser = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

function request(
  path: string,
  headers: Record<string, string> = browser,
  cookie = "",
  isBot = false,
): PageRequest {
  const url = new URL(path, "http://localhost:3000");
  const sent = new Headers(headers);
  const jar = new Set(
    cookie
      .split(";")
      .map((part) => part.split("=")[0]?.trim())
      .filter(Boolean),
  );
  return {
    pathname: url.pathname,
    search: url.search,
    method: "GET",
    headers: sent,
    cookies: jar,
    isBot,
  };
}

test("only real page loads in a browser count", () => {
  assert.equal(isPageLoad(request("/projects")), true);
  assert.equal(isPageLoad(request("/auth/login")), false);
  assert.equal(isPageLoad(request("/cv/file.pdf"), ["/cv/"]), false);
  assert.equal(isPageLoad(request("/projects", { ...browser, rsc: "1" })), false);
  assert.equal(isPageLoad(request("/projects", browser, "", true)), false);
  assert.equal(isPageLoad(request("/projects", {})), false);
});

test("the silent check runs only for a returning, signed-out browser", () => {
  process.env.OIDC_ISSUER_URL = "http://id.localhost/application/o/pf/";
  process.env.APP_URL = "https://example.com";
  const options = { cookiePrefix: "pf" };
  const origin = "http://container:3000";

  assert.equal(silentCheckUrl(request("/projects"), options, origin), null, "new visitor");
  assert.equal(
    silentCheckUrl(request("/projects", browser, "pf_returning=1; pf_session=x"), options, origin),
    null,
    "already signed in",
  );
  assert.equal(
    silentCheckUrl(
      request("/projects", browser, "pf_returning=1; pf_sso_checked=1"),
      options,
      origin,
    ),
    null,
    "checked a moment ago",
  );

  const always = { cookiePrefix: "pf", mode: "always" as const };
  assert.ok(silentCheckUrl(request("/projects"), always, origin), "always: a new visitor too");
  assert.equal(
    silentCheckUrl(request("/projects"), { cookiePrefix: "pf", mode: "off" }, origin),
    null,
    "off",
  );

  const hop = silentCheckUrl(request("/projects?a=1", browser, "pf_returning=1"), options, origin);
  assert.equal(hop?.origin + (hop?.pathname ?? ""), "https://example.com/auth/login");
  assert.equal(hop?.searchParams.get("silent"), "1");
  assert.equal(hop?.searchParams.get("returnTo"), "/projects?a=1");
});
