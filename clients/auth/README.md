# @thebensage-dev/auth

Sign-in through TheBensage's authentik (the `identity/` stack in this repo) for a Next.js 16 app. Portfolio, the User Directory and the CMS all use it, so the flow is written and tested once.

- **OpenID Connect**, authorization code with PKCE.
- **An encrypted session cookie** (A256GCM, keyed from `AUTH_SECRET`; no session table) with the name, email, authentik groups and session id. With `keepTokens` it also keeps authentik's access and refresh tokens, and `accessToken()` refreshes them.
- **Silent single sign-on:** someone signed in to authentik in another app is signed in here without a click. The proxy only checks for browsers that have signed in here before, never for bots or link previews.
- **Single logout** through authentik's shared `sign-out` flow and each app's front-channel logout page.

What someone may do comes from their groups, which each app checks itself.

## Install

It's on GitHub Packages, like the other `@thebensage-dev` packages. A project's `.npmrc` (gitignored) needs a token with `read:packages`, and its CI needs this package's **Manage Actions access** to list the repo.

```powershell
npm install @thebensage-dev/auth
```

## Use

```ts
// src/server/auth.ts
import { createAuth, inGroup } from "@thebensage-dev/auth";

export const auth = createAuth({ app: "portfolio", cookiePrefix: "pf", name: "the site" });

export async function currentUser() {
  const session = await auth.currentSession();
  return session && { ...session, member: inGroup(session.groups, ["portfolio-members"]) };
}
```

```ts
// src/app/auth/login/route.ts (and callback, logout, frontchannel-logout the same way)
import { authRoutes } from "@thebensage-dev/auth";
import { auth } from "@/server/auth";

export const { GET } = authRoutes(auth).login;
```

```ts
// src/proxy.ts
import { NextResponse, type NextRequest } from "next/server";
import { singleSignOn } from "@thebensage-dev/auth/proxy";

export function proxy(request: NextRequest) {
  return singleSignOn(request, { cookiePrefix: "pf" }) ?? NextResponse.next();
}

// Keep authentik's front-channel logout page out of the proxy.
export const config = { matcher: ["/((?!_next/static|_next/image|auth/frontchannel-logout).*)"] };
```

| Option         | What it does                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`          | The app's slug in authentik's shared flows (`?app=`).                                                                                               |
| `cookiePrefix` | `pf` gives `pf_session`, `pf_login`, `pf_sso_checked` and `pf_returning`.                                                                           |
| `name`         | Named in the front-channel logout's answer.                                                                                                         |
| `home`         | Where to go when there's nowhere better (default `/`).                                                                                              |
| `loginPage`    | Where a failed (`?signin=failed`) or refused (`?signin=denied`) sign-in goes.                                                                       |
| `appUrlEnv`    | The env var with the app's public URL (default `APP_URL`).                                                                                          |
| `allowReturn`  | Narrows where a sign-in may return to (the CMS: `/admin` only).                                                                                     |
| `keepTokens`   | Keep authentik's tokens, for an app that calls an API as the person.                                                                                |
| `silentSignOn` | `"returning"` (default: only browsers that signed in here before, via a `_returning` cookie), `"always"` or `"off"`; the proxy's `mode` matches it. |
| `onSignIn`     | Runs before the session is set; throw `AccessDenied` to refuse.                                                                                     |

Env: `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `AUTH_SECRET` and the app's URL, all or none (none: sign-in is off). Optional `OIDC_INTERNAL_URL`, for a server that reaches authentik at another address (the local Docker stack).

## Working on it

```powershell
npm install
```

```powershell
npm run check
```

`check` runs Prettier, the types, the tests (`node --test`) and the build. The **Auth package** workflow runs it on every push. On `main` it publishes when `package.json`'s version isn't on GitHub Packages yet, then tags the commit `auth-v<version>`. A release is a version bump.

It imports Next by its bare paths (`next/headers`), which only a bundler resolves. An app's Vitest config inlines it: `server: { deps: { inline: ["@thebensage-dev/auth"] } }`.
