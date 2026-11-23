# Infrastructure

Monitoring and sign-in for the sites on the Coolify VPS (Portfolio, the User Directory, Storybook, and any later ones). `identity/` and `monitoring/` each deploy as their own Coolify application from this repo. `local/` is never deployed: it runs every site together on your machine.

## What is in this repo

| Folder        | What it runs                                                                                                                                                                                                                                                         | URL                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `monitoring/` | **Prometheus** collects metrics and **Loki** stores every container's logs (sent by **Alloy**). **Grafana** shows dashboards and logs and sends alerts. Three small exporters feed Prometheus: blackbox (site checks), node (the VPS) and cAdvisor (each container). | `grafana.<domain>` only |
| `identity/`   | **authentik**: single sign-on (OIDC) for Portfolio, the User Directory, the API, Grafana and later tools. Passwords plus optional passkeys and two-factor, groups, one shared "Request access" page where people pick apps and you approve each one (with emails), and invite links for guests.                               | `id.<domain>`           |
| `local/`      | **Local only, never deployed.** Portfolio, User Directory, Storybook and the API built from the sibling repos, behind a Caddy proxy.                                                                                                                                          | `localhost:8080`        |

Coolify's own features cover the rest: deploy failures, server disk usage and "server unreachable" notifications, and live container logs on each app's Logs tab (recent lines only; Grafana keeps 14 days of every container's logs, searchable together).

## How it fits with the other repos

| Repo                      | Role                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Infrastructure** (this) | authentik at `id.<domain>` and Grafana at `grafana.<domain>`, on the same Coolify VPS as the sites. It watches them all. |
| Portfolio                 | Landing site at `<domain>`.                                                                                              |
| UserDirectory             | The app at `users.<domain>`. It keeps no data: it reads and writes through the Api.                                      |
| SharedUI                  | `@thebensage-dev/ui` (GitHub Packages) and its Storybook at `ui.<domain>`.                                                  |
| Api                       | The .NET API at `api.<domain>`, with its own PostgreSQL. `/health` is checked, so a broken database shows.                 |

The VPS stacks don't depend on the Node repos: no npm, no `NODE_AUTH_TOKEN`. Their only link is the list of URLs in `MONITORED_SITES`. The local all-sites stack in `local/` is the exception: it builds the four sibling repos (see [Running all the sites locally](#running-all-the-sites-locally)).

## Prerequisites

- A Coolify VPS with DNS for `id.<domain>` and `grafana.<domain>`.
- An SMTP account for alert and access-request emails. Gmail with an [app password](https://myaccount.google.com/apppasswords) for now; another provider later is just new values under [Deploying](#deploying).
- Docker Desktop, only to try the stacks locally.

## What you get

Everything is provisioned from git, so a redeploy always gives the same setup:

- **Dashboard "Sites and server"** (Grafana > Dashboards > Monitoring): up/down, uptime %, response time and TLS days left for each site; CPU, memory and disk for the VPS; CPU and memory per container.
- **Email alerts** (`monitoring/grafana/provisioning/alerting/rules.yaml`):

  | Alert                     | Fires when                                           |
  | ------------------------- | ---------------------------------------------------- |
  | Site down                 | a site doesn't answer 2xx over valid HTTPS for 3 min |
  | Site slow                 | responses take over 3 s for 10 min                   |
  | TLS certificate expiring  | under 14 days left (renewal is failing)              |
  | Disk almost full          | root disk over 85 %                                  |
  | Memory high / CPU high    | over 90 % for 10 / 15 min                            |
  | Monitoring component down | Prometheus can't reach one of the exporters          |

- **Access control**: Grafana signs in through authentik. Members of `grafana-admins` (and authentik's own `authentik Admins`) get Admin, members of `grafana-viewers` get read-only, and authentik refuses anyone else before they reach Grafana.

## Security

- Only Grafana has a public URL, over HTTPS through Coolify's proxy. Prometheus and the exporters publish no ports and have no domain; they're reachable only inside the stack's private network.
- The exporters mount the host read-only and none runs privileged. cAdvisor and Alloy also see the Docker socket (cAdvisor through `/var/run`). A read-only mount doesn't limit what can be asked of the Docker API, so treat both as trusted, pinned images; a socket proxy that only allows reads is the next hardening step if you want one.
- Sign-in through authentik with PKCE: passwords, plus passkeys and two-factor for anyone who adds them. Only authentik admins and the `grafana-*` groups get in ("Request access" never offers Grafana), and anonymous access is off. Opening Grafana goes straight to authentik (`GF_AUTH_OAUTH_AUTO_LOGIN`), so anyone already signed in to authentik, from the User Directory for example, gets in with no click. The local `admin` password is Grafana's break-glass account (form at `/login?disableAutoLogin=true`); hide the form once authentik works (`GRAFANA_DISABLE_LOGIN_FORM=true`).
- Secrets live in GitHub, as `production` environment secrets that only an approved deploy from `main` can read. The deploy job writes them into the Coolify apps' environment variables; nothing is typed into Coolify. Each stack's `.env.example` lists the keys the apps receive.

## Resources

Measured locally: about 850 MB of RAM for monitoring, most of it Grafana (~590 MB); Loki and Alloy add about 90 MB. authentik (server, worker and PostgreSQL, no Redis) uses about 770 MB more with one web worker (`AUTHENTIK_WEB__WORKERS`). Loki keeps 14 days of logs (`LOKI_RETENTION`). Prometheus keeps 30 days or 5 GB of history, whichever comes first (`PROMETHEUS_RETENTION_TIME` / `PROMETHEUS_RETENTION_SIZE`). If the VPS is tight on memory, set a memory limit for Grafana in Coolify.

## Before you start

1. Create a GitHub repo from this folder in GitHub Desktop (File > Add local repository, then "create a repository" when it offers) and publish it to the **thebensage-dev** organization. Before the first commit, check that no `.env` file is in the Changes list.
2. Add DNS records pointing at the VPS: `id` and `grafana` (or a wildcard `*`).
3. In Coolify, turn on **2FA** for your own account (Profile > Two-factor), and set up **Notifications** (Settings > Notifications, e.g. Email) for deployment failures, server disk usage and server unreachable.

## CI

One workflow, `.github/workflows/ci.yml` ("CI"), with the same shape as the other three repos:

| Job                  | Runs on                         | What it does                                                                                                                                                                                                 |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Check**            | every PR and push               | Lints the workflows and shell scripts (actionlint, shellcheck), checks both compose files resolve and the Prometheus config with `promtool`, then builds every identity and monitoring image.            |
| **Find the changed stacks** | push to `main`, manual run | Works out which stacks changed (`identity/`, `monitoring/` or `sites.yml`), or takes the stack picked in a manual run. |
| **Check Coolify is ready** | push to `main`, manual run | The same gate as the other repos: `DOMAIN` set and `https://coolify.<DOMAIN>/api/health` answers. If not, deploys are skipped with a notice, so the run stays green before go-live. |
| **Deploy to Coolify** | after your approval            | Checks every deploy value is set, then deploys identity (first) and/or monitoring through `.github/actions/coolify-deploy`, pinned to this commit, and waits for Coolify to finish.                       |
| **Redeploy the sites** | manual run with the box ticked | Starts each site's own CI on `main` from `sites.yml` (needs `SITES_DISPATCH_TOKEN`).                                                                                                                  |

The identity build downloads SharedUI's `brand/` files from its release tag (`SHAREDUI_REF` in `identity/authentik/Dockerfile`), so **Check** can only pass once SharedUI is public on GitHub and its tag (`v1.0.0`) exists. `.github/dependabot.yml` opens weekly PRs for image tags (Dockerfiles and compose files) and actions.

## Deploying

Each repo deploys itself from its own GitHub Actions pipeline: on a push to `main` (or Actions > CI > **Run workflow**) it checks the change, then waits for your approval, then sends it to Coolify. Settings and secrets live only in GitHub (repository or organization secrets and variables) and travel to Coolify in that run, through Coolify's API; nothing is typed into Coolify and its Auto Deploy stays off. The deploy step itself lives once, in this repo: the composite action `.github/actions/coolify-deploy` (`action.yml` + `deploy.sh`). The other three repos call it as `thebensage-dev/Infrastructure/.github/actions/coolify-deploy@main`, and this repo uses its own copy at the same commit, so a fix to it is one edit.

In this repo the `deploy` job deploys only the stacks whose folder changed (`identity/`, `monitoring/`), identity first, each pinned to the commit. The apps (Portfolio, User Directory, Storybook) are built into images by their own pipelines and deployed the same way; see their READMEs.

**`sites.yml`** lists the sites the platform hosts: each one's repo and the URLs Grafana should check. The pipeline builds Grafana's `MONITORED_SITES` from it (changing it redeploys monitoring), so adding a site means one entry there, its DNS record and the same pipeline in its repo.

**Redeploying everything** (a new server, or after a restore): Actions > CI > **Run workflow**, stack `both`, tick **Also redeploy the sites**, then approve. After the platform is up it starts each site's pipeline from `sites.yml`; approve those as they come in. Pick stack `none` to only redeploy the sites. Starting another repo's workflow needs the secret `SITES_DISPATCH_TOKEN`: a fine-grained token (GitHub > Settings > Developer settings > Fine-grained tokens) for the four site repos with **Actions: Read and write**.

**One-time setup for this repo:** Settings > Environments > New environment `production`: tick **Required reviewers** and add yourself (later, your team), and under **Deployment branches and tags** allow only `main`. **Secrets** are environment secrets there, so only an approved deploy from `main` can read them; a pull request or another branch never sees them. **Variables** aren't secret and are set once for every repo as organization variables (thebensage-dev > Settings > Secrets and variables > Actions > Variables). The script below ("Every value for all five repos at once") sets all of it. The email settings are all set explicitly, so moving off Gmail later only means new values (and a redeploy), no code change. The deploy stops with a list of anything missing. Until `DOMAIN` exists, the deploy job is skipped.

| Name              | Kind               | Value                                                                                                                                                                                         |
| ----------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`          | org variable       | `example.com`. Every address comes from it (`id.`, `grafana.`, `users.`, `coolify.`…), and so does the Live status token, so Portfolio's footer link matches without copying anything.        |
| `COOLIFY_TOKEN`   | environment secret | Coolify API token with **write** and **deploy** (Keys & Tokens > API tokens; turn on Settings > Advanced > API Access first)                                                                  |
| `PLATFORM_SECRET` | environment secret | 64 random characters, the same value as in UserDirectory and Portfolio. The pipeline derives the OIDC client secrets from it (`derive:` in `ci.yml`), so authentik, Grafana, the User Directory and Portfolio agree. |
| `SMTP_HOST`       | org variable       | the SMTP server. Gmail for now: `smtp.gmail.com`                                                                                                                                              |
| `SMTP_PORT`       | org variable       | Gmail: `587`                                                                                                                                                                                  |
| `SMTP_USE_TLS`    | org variable       | `true` for STARTTLS on port 587 (Gmail). authentik reads it; Grafana negotiates STARTTLS by itself                                                                                            |
| `SMTP_USERNAME`   | org variable       | the SMTP login. Gmail: your Gmail address                                                                                                                                                     |
| `SMTP_PASSWORD`   | environment secret | the SMTP password. Gmail: an [app password](https://myaccount.google.com/apppasswords)                                                                                                        |
| `ALERT_EMAIL_FROM`| org variable       | the sender of alerts and access-request emails. Gmail: your Gmail address (Gmail rewrites any other sender)                                                                                   |
| `ALERT_EMAIL_TO`  | org variable       | who gets alerts and new access requests (several: separate with `;`); also authentik's admin email on the first deploy                                                                         |

Optional: `GRAFANA_DISABLE_LOGIN_FORM` (variable, `true` once authentik sign-in to Grafana works), `SITES_DISPATCH_TOKEN` (secret, for "Also redeploy the sites" above), and overrides `COOLIFY_URL` (if Coolify isn't at `https://coolify.<DOMAIN>`) and `COOLIFY_IDENTITY_UUID` / `COOLIFY_MONITORING_UUID` (if the Coolify apps aren't named `identity` and `monitoring`).

**Every value for all five repos at once**, with the [GitHub CLI](https://cli.github.com) (`gh auth login` once, as an owner of thebensage-dev, then `gh auth refresh -h github.com -s admin:org` so it may set organization variables; after the five repos are published). Run it in PowerShell. It asks for each value and shows none. It also sets up each repo's `production` environment (you as required reviewer, `main` only) and a ruleset that protects `main`: no deletion or force push, and pull requests need the CI job "Check" to pass (every repo names its first job that). Organization admins (you) can bypass it, so your own pushes from GitHub Desktop still work. Running it again is safe: it keeps an existing `PLATFORM_SECRET` (a new one would change the client secrets and sign everyone out), and a secret you leave empty (press Enter) is skipped, not cleared. So you can run it before the VPS exists, leaving the Coolify token empty, and again once Coolify is up, entering only the token. Setting `DOMAIN` early is fine: every deploy job first checks that `https://coolify.<DOMAIN>` answers, and is skipped (green) until it does.

```powershell
$org = 'thebensage-dev'
$domain = Read-Host 'Domain (example.com)'
$smtpHost = Read-Host 'SMTP server (Gmail: smtp.gmail.com)'
$smtpPort = Read-Host 'SMTP port (Gmail: 587)'
$smtpUser = Read-Host 'SMTP username (Gmail: your Gmail address)'
$mailFrom = Read-Host 'Send emails from (Gmail: your Gmail address)'
$mailTo = Read-Host 'Send alerts and access requests to'
$coolify = Read-Host 'Coolify API token (Enter to skip until Coolify is set up)' -AsSecureString
$smtpPass = Read-Host 'SMTP password, Gmail: an app password (Enter to keep the current one)' -AsSecureString
function Get-PlainText($s) { [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
$bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$platform = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
$me = gh api user --jq .id

# Organization variables: not secret, one place for every repo.
gh variable set DOMAIN --org $org --visibility all -b $domain
$mail = @{ SMTP_HOST = $smtpHost; SMTP_PORT = $smtpPort; SMTP_USE_TLS = 'true'; SMTP_USERNAME = $smtpUser; ALERT_EMAIL_FROM = $mailFrom; ALERT_EMAIL_TO = $mailTo }
foreach ($k in $mail.Keys) { gh variable set $k --org $org --visibility selected --repos Infrastructure -b $mail[$k] }

foreach ($r in 'SharedUI', 'Infrastructure', 'UserDirectory', 'Portfolio', 'Api') {
  # The production environment: your approval, main only.
  "{`"reviewers`":[{`"type`":`"User`",`"id`":$me}],`"deployment_branch_policy`":{`"protected_branches`":false,`"custom_branch_policies`":true}}" |
    gh api -X PUT "repos/$org/$r/environments/production" --input - | Out-Null
  $policies = gh api "repos/$org/$r/environments/production/deployment-branch-policies" --jq '.branch_policies[].name'
  if ($policies -notcontains 'main') { gh api -X POST "repos/$org/$r/environments/production/deployment-branch-policies" -f name=main | Out-Null }

  # Environment secrets: only an approved deploy from main can read them.
  # Empty answers are skipped, and an existing PLATFORM_SECRET is kept.
  $existing = gh secret list -R "$org/$r" -e production --json name --jq '.[].name'
  if ($coolify.Length -gt 0) { gh secret set COOLIFY_TOKEN -R "$org/$r" -e production -b (Get-PlainText $coolify) }
  if ($r -in 'Infrastructure', 'UserDirectory', 'Portfolio' -and $existing -notcontains 'PLATFORM_SECRET') { gh secret set PLATFORM_SECRET -R "$org/$r" -e production -b $platform }
  if ($r -eq 'Infrastructure' -and $smtpPass.Length -gt 0) { gh secret set SMTP_PASSWORD -R "$org/$r" -e production -b (Get-PlainText $smtpPass) }

  # Protect main (once).
  $rulesets = gh api "repos/$org/$r/rulesets" --jq '.[].name'
  if ($rulesets -notcontains 'Protect main') {
    $rules = '{"name":"Protect main","target":"branch","enforcement":"active",' +
      '"bypass_actors":[{"actor_id":1,"actor_type":"OrganizationAdmin","bypass_mode":"always"}],' +
      '"conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},' +
      '"rules":[{"type":"deletion"},{"type":"non_fast_forward"},' +
      '{"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false}},' +
      '{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,"required_status_checks":[{"context":"Check"}]}}]}'
    $rules | gh api -X POST "repos/$org/$r/rulesets" --input - | Out-Null
  }
  Write-Output "$r done"
}
```

To change one value later, use the same `gh` line on its own, or the GitHub website: organization variables under thebensage-dev > Settings > Secrets and variables > Actions, secrets under each repo > Settings > Environments > `production`. When the team grows, add teammates as required reviewers there: they can then approve deploys without ever seeing a secret.

### What stays manual, and why

Everything after the first setup is push, then approve. What can't sensibly live in a pipeline is the one-time groundwork, because the pipeline needs it to exist first:

| When          | Step                                                                       | Why it's manual                                                                 |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Once          | Rent the VPS, install Coolify, add the DNS records                         | the pipeline deploys onto them                                                  |
| Once          | Coolify API access and token; `docker login ghcr.io` on the server         | they're what lets GitHub reach Coolify and Coolify reach the images             |
| Once per app  | Create the app in Coolify (type, name, domain, volume)                     | the pipeline finds it by name; six apps by hand is quicker than scripting them |
| Once per repo | The `production` environment and its reviewer; the few values (one script) | they're the pipeline's input                                                    |
| Once          | Sign in as `akadmin`, add a passkey                                        | the admin's own credentials                                                     |
| Each change   | Approve the deploy                                                         | your choice: drop the required reviewer to deploy automatically                 |

Passwords that belong to one stack aren't in GitHub at all: Coolify generates them on the first deploy (the `SERVICE_PASSWORD_*` variables in the compose files: authentik's keys, the `akadmin` password and Grafana's `admin` password) and shows them under the app's Environment Variables.

### Coolify can pull the app images

Check thebensage-dev > Packages after the first image builds: if `portfolio`, `user-directory`, `storybook` and `api` show as **Public** (they can follow the public repos), Coolify pulls them with no login and you can skip this. If they're private, log Docker in once on the VPS (IONOS Remote console, or SSH) with a classic token that has only `read:packages`:

```bash
docker login ghcr.io -u TheBensage   # paste the token as the password
```

## Deploy 1: identity (authentik)

Everything authentik needs is created on start from one blueprint, `identity/authentik/blueprints/platform.yaml`, which `identity/authentik/Dockerfile` bakes into the image (one file, because blueprints that depend on each other can hang authentik's worker):

- The groups `grafana-admins`, `grafana-viewers`, `user-directory-editors`, `api-editors` and `portfolio-members`, and the OIDC apps **Grafana** (client id `grafana`), **User Directory** (`user-directory`), **API** (`api`, a public client with PKCE for the API's docs page, so no secret) and **Portfolio** (`portfolio`, the main site) with their callback URLs and secrets. The API also accepts User Directory tokens, which that app forwards on writes.
- **Single sign-on, and who may do what.** Any authentik account can sign in to Portfolio, the User Directory and the API: those apps have no group rules in authentik, so their silent sign-in check (OIDC `prompt=none`) always comes straight back, signed in or not. (With group rules, someone signed in elsewhere but not in that app's group would be stuck on authentik's "access denied" page.) Each app then reads the `groups` claim in the token: `portfolio-members` unlock the colour palette, `user-directory-editors` may edit the directory, `api-editors` may write through the API's docs, and `authentik Admins` may do everything. Everyone else signed in sees "request access" in the app. Grafana keeps its group rules, since it's yours alone.
- A "Sign in to TheBensage" page (`AUTHENTIK_BRAND_TITLE`) with username and password on one screen and passkey autofill, used by Portfolio, Grafana and authentik itself, and the User Directory's own "Sign in to the User Directory" page (`user-directory-sign-in`). Both have a "Need an account?" link to Request access.
- **Request access** (`request-access`, one page for every app; the apps link to `/if/flow/request-access/?app=<slug>`, which ticks that app). Someone new first creates their account (name, email, username, password), which works straight away but grants nothing; someone already signed in skips that. Then they tick the apps they'd like (Portfolio, User Directory, API) with an optional reason, and authentik sends them back to the app they came from, signed in. Their picks are kept on the user (attribute `requested_apps`), and the admins get an email (plus the bell for a new account). See "Approve an access request" below. For another app, add it to the `APPS` lists in the blueprint's request expressions and give it a checkbox.
- The invitation-only guest sign-up `guest-invite` (name, email, username, password and a link to the privacy notice). New users land in `user-directory-editors`.
- People who request access or accept an invite are **external** users: they can sign in to the apps they're allowed into, and opening `id.<domain>` sends them to the User Directory (the brand's default application) rather than authentik's own pages. Admin "Impersonate" is switched off (`authentik/settings.py`), since it only swaps authentik's session, not the apps'.
- **Your account** (`account`, `account-password`): any signed-in user can change their name and email, or their password (after entering the current one), then goes back to the app they came from (`?app=portfolio` or `user-directory`) through a fresh sign-in. Portfolio and the User Directory link to it from the signed-in name in their header.
- **Sign out** (`sign-out`, every provider's invalidation flow): one sign-out for every app. The apps' Sign out buttons open `/if/flow/sign-out/?app=<slug>` (Grafana's goes through its end-session URL); it ends the authentik session, then loads Portfolio's and the User Directory's front-channel logout pages (`<app>/auth/frontchannel-logout`, the providers' `logout_uri`) in hidden frames so they drop their sessions too, and returns to the app. Grafana has no front-channel logout, so it stays signed in until you sign out of it.
- Emails use `identity/authentik/templates/email/site_base.html` (the sites' look, inline styles) and an email logo PNG drawn from `brand/logo.svg` when the image builds, which replaces authentik's attached logo.
- The sites' look: `identity/authentik/brand.css` (dark colours, blue primary, rounded cards) and `identity/authentik/brand/` (logo, favicon, and the background that replaces authentik's stock photo), served from `/static/dist/assets/brand/`.
- **Colours and logo** come from SharedUI's `brand/` folder (`palette.json`, the one place the sites' colours are defined, and `logo.svg`). The Dockerfile downloads both from a tagged SharedUI release, `SHAREDUI_REF` (e.g. `v1.0.0`), so this repo holds no copy. To change them: edit SharedUI, release it (its CI tags `v<version>`), then bump `SHAREDUI_REF` in `identity/authentik/Dockerfile` here. The local all-sites stack uses the sibling `SharedUI/brand` folder instead (`local/identity.override.yaml`), so a change shows locally before any release. The CSS, SVGs and email templates use `[[light.<name>]]` / `[[dark.<name>]]` instead of colours, and the Dockerfile's first stage (`render-brand.mjs`) fills them in and draws the email logo, so an unknown name fails the build.

The small `authentik-settings` service sets what blueprints can't: the Privacy and Terms links under every sign-in page (from `MAIN_SITE_URL`). It runs once per deploy and then sleeps. The client secrets come from GitHub in the deploy run, so nothing is copied between apps by hand. The blueprints are re-applied on every start and hourly, so change these objects in the files, not in the UI.

1. Coolify > New resource > Private repository (GitHub App) > this repo, named `identity`. Build pack **Docker Compose**, base directory `/identity`, compose file `/compose.yaml`.
2. Environment variables: none by hand. The pipeline writes the ones in `identity/.env.example`, and Coolify generates the secret key, the database password and `SERVICE_PASSWORD_AKADMIN`, the password of the admin user `akadmin`.
3. Domain of the `authentik-server` service: `https://id.<domain>:9000`. The `:9000` is the container port Coolify forwards to, not a public port. The other services get no domain.
4. Deploy. Copy `SERVICE_PASSWORD_AKADMIN` from the app's Environment Variables into your password manager, then sign in at `https://id.<domain>` as `akadmin` with it. In your user settings, add a passkey or an authenticator app (recommended for the admin). Its email is `ALERT_EMAIL_TO` from the first deploy (`AUTHENTIK_BOOTSTRAP_EMAIL`); change it under Directory > Users if needed.
5. That's all: Grafana and the User Directory already exist as applications, and `akadmin` (group `authentik Admins`) may use both, as Admin in Grafana.

`authentik_db` holds every user, passkey and setting. Back it up (Coolify > the app > Storages, or a scheduled database backup). `authentik_data` only holds uploaded logos.

Password reset by email needs the SMTP settings (shared with Grafana) and a recovery flow; until then, an admin can create a one-time recovery link for a user under Directory > Users.

## Deploy 2: monitoring (Prometheus + Grafana)

1. Coolify > New resource > the same repo, named `monitoring`. Build pack **Docker Compose**, base directory `/monitoring`, compose file `/compose.yaml`.
2. Environment variables: written by the pipeline (the keys in `monitoring/.env.example`). Coolify generates `SERVICE_PASSWORD_GRAFANAADMIN`, the password of Grafana's break-glass `admin`; copy it into your password manager.
   - `MONITORED_SITES` is built from `sites.yml` with your `DOMAIN`, e.g. `https://example.com,https://users.example.com,https://ui.example.com,https://api.example.com/health,https://id.example.com/-/health/ready/`. The API's `/health` also checks its PostgreSQL, and authentik's readiness check does the same for its own.
   - Email: the `SMTP_*` and `ALERT_EMAIL_*` GitHub variables above (Gmail for now). Several recipients in `ALERT_EMAIL_TO`: separate with `;`.
3. Domain: set it on the `grafana` service only, as `https://grafana.<domain>:3000`. Leave every other service without a domain.
4. Deploy. Open `https://grafana.<domain>` and choose **Sign in with authentik**.
5. Test the alerts: Alerting > Contact points > Email > **Test**.
6. Once authentik sign-in works, set the GitHub variable `GRAFANA_DISABLE_LOGIN_FORM` to `true` (not in Coolify: the next deploy would overwrite it), then Actions > CI > Run workflow, stack `monitoring`.

## Watch the watcher

Everything above runs on the VPS, so if the whole VPS goes down nothing on it can email you. Add one free external check (for example the free plans of UptimeRobot or Better Stack) on `https://<domain>` and `https://grafana.<domain>/api/health`, which is public and returns `"database": "ok"`.

## Common changes

- **Monitor another site:** add it to `sites.yml` and push. The pipeline redeploys monitoring with the new checks; the dashboard and alerts pick it up automatically.
- **Give someone access to Grafana:** in authentik, add them to `grafana-viewers` (read-only) or `grafana-admins` (Directory > Groups). Remove them from the group to revoke access; it takes effect at their next sign-in.
- **Approve an access request (app by app):** when someone uses "Request access", they get a "we've got your request" email naming the apps, you get a "New access request" email at `ALERT_EMAIL_TO`, and a second account with the same email or username is refused. To approve an app, add the person to its group: authentik > Directory > Groups > `portfolio-members`, `user-directory-editors` or `api-editors` > Users > Add existing user (their pending apps and reason are in the user's attributes, `requested_apps` and `access_reason`; new accounts are under `users/members`). They get a "you're in" email for that app once, and it moves to `approved_apps`. It takes effect at their next sign-in to that app (the User Directory offers "refresh your sign-in"). To refuse, leave it, or delete the user to remove the account. Emails use the same SMTP settings as Grafana's alerts, also passed to identity; without `SMTP_HOST` nothing is emailed.
- **Temporary guest access to the User Directory:** authentik > Directory > Invitations > Create: flow `guest-invite`, tick **Single use**, set an expiry, then copy the link and email it. The guest picks their own password and can edit the directory, nothing else. When they're done, deactivate or delete them under Directory > Users.
- **Change an alert threshold:** edit `monitoring/grafana/provisioning/alerting/rules.yaml` and redeploy. Rules from git are locked in the UI so they can't drift.
- **Change the dashboard:** edit it in Grafana, then use Export > JSON and replace `monitoring/grafana/dashboards/sites-and-server.json`. Or use Save as to keep a separate UI-only copy.
- **More dashboards:** community dashboards such as "Node Exporter Full" (ID 1860) can be imported from Dashboards > New > Import.
- **Alerts somewhere else** (Discord, Telegram, Slack, ntfy…): add a contact point in `monitoring/grafana/provisioning/alerting/contact-points.yaml`.
- **Another server:** run node-exporter and cAdvisor there and add them as targets in `monitoring/prometheus/prometheus.yml`. Don't expose them publicly; use a private network or a VPN between the servers.
- **Logs:** Alloy reads every container's output through the Docker socket (read-only) and sends it to Loki. In Grafana, the dashboard's Logs row shows error lines by service; Explore > Loki searches everything, e.g. `{service="user-directory"} |= "error"`. Labels: `service`, `container`, `project`, `stream`.

## Updating

Image versions are pinned in `monitoring/compose.yaml`, `identity/compose.yaml` and the Dockerfiles under `monitoring/` and `identity/authentik/`. Prometheus is on the 3.13 LTS line. authentik is pinned to an exact release in `identity/authentik/Dockerfile` (currently `2026.8.6`), so it only upgrades when you change that line. authentik supports upgrading one minor line at a time (2026.8 to 2026.11, never straight to 2027.2), each time to that line's latest patch: read the release notes, bump, redeploy, repeat. PostgreSQL stays on 16; Dependabot skips its major versions, because a major upgrade needs a dump and restore.

`.github/workflows/ci.yml` checks every PR and push: both deployable compose files must resolve, the monitoring and authentik images must build and `promtool` must accept `prometheus.yml`. Deploys only happen on `main`, after your approval (see [Deploying](#deploying)). `.github/dependabot.yml` opens weekly PRs for newer image tags, covering the `FROM` lines in `monitoring/*/Dockerfile` and the `image:` lines in both compose files, plus the GitHub Actions versions. Check the release notes before merging; merging to `main` then deploys through the pipeline after your approval (Coolify's Auto Deploy stays off).

## Persistent volumes

All data lives in named volumes that Coolify keeps across redeploys: `authentik_db`, `authentik_data`, `grafana_data`, `prometheus_data`, `loki_data` and `alloy_data`. Losing `authentik_db` loses every user, passkey and invitation (groups and apps come back from the blueprints), so back it up. The rest can be rebuilt from git, apart from history and anything edited in the UI.

## Running all the sites locally

`local/compose.yaml` builds Portfolio, the User Directory, Storybook and the API from the sibling folders (`../../Portfolio`, `../../UserDirectory`, `../../SharedUI`, `../../Api`; the API with its own PostgreSQL, `api-db`) and puts them behind a small [Caddy](https://caddyserver.com) proxy that routes by host name. It's for testing on your machine only. On the VPS each site is its own Coolify app, and Coolify's proxy does the routing and HTTPS.

The two Next.js builds install `@thebensage-dev/ui` from GitHub Packages, so they need **`NODE_AUTH_TOKEN`**: a classic GitHub token with only the `read:packages` scope (github.com → Settings → Developer settings → Personal access tokens → Tokens (classic)). Put it in `local/.env`, which is gitignored and read by Compose automatically:

```powershell
cd local
Copy-Item .env.example .env   # then paste the token after NODE_AUTH_TOKEN=
docker compose up --build -d
```

Compose passes it to `npm ci` as a BuildKit secret, so it never ends up in an image or in `docker history`. Storybook's build doesn't need it. A `NODE_AUTH_TOKEN` already set in your shell takes priority over the file. The file is `.env` rather than `.env.local` because Compose only picks up `.env` by itself; any other name needs `--env-file` on every command.

**Installing outside Docker** (in Portfolio or UserDirectory) uses that repo's own gitignored `.npmrc`: copy its `.npmrc.example`, paste the same token, then run plain `npm install`. See each repo's README.

The same `docker compose up` also starts authentik (`identity/`) and the monitoring stack (`monitoring/`) in the same network, adjusted for local use: authentik gets local-only placeholder keys and client secrets (`local/identity.env`), Grafana signs in through the local authentik and sends no email unless you fill in the optional `SMTP_*` lines in `local/.env` (`local/monitoring.override.yaml`, `local/monitoring.env`), and the sites are checked over plain HTTP by their service names (`local/blackbox.yml`). Besides `NODE_AUTH_TOKEN`, the one thing you set is `SERVICE_PASSWORD_AKADMIN` in `local/.env`, the password of authentik's `akadmin`. It's read the first time authentik starts with an empty database.

| URL                              | Goes to                                                               |
| -------------------------------- | --------------------------------------------------------------------- |
| http://localhost:8080            | Portfolio                                                             |
| http://users.localhost:8080      | User Directory (its demo people come from the API)                    |
| http://ui.localhost:8080         | Storybook for `@thebensage-dev/ui`                                       |
| http://api.localhost:8080        | The API's docs (Scalar); "Authentication" signs in through authentik   |
| http://id.localhost:8080         | authentik: sign in as `akadmin` with the password from `local/.env`   |
| http://grafana.localhost:8080    | Grafana: "Sign in with authentik", or `admin` / `admin` as a fallback |
| http://prometheus.localhost:8080 | Prometheus (Status > Targets shows every scrape)                      |

**Sign-in works straight away:** authentik's blueprints create the Grafana and User Directory apps with the same placeholder secrets the local Grafana and User Directory use, and `akadmin` may use both. To try a guest, create an invitation (flow `guest-invite`) in authentik and open its link in a private window. authentik and Grafana keep their data in the `server_authentik_db` and `server_grafana_data` volumes.

**Public status page:** the "Live status" dashboard (`monitoring/grafana/dashboards/status.json`) holds only the site checks and server load, no logs or per-container data. Grafana makes it public on every start (`monitoring/grafana/share-status.sh`) at the fixed link http://grafana.localhost:8080/public-dashboards/10ca1000000000000000000000000000, which the main site's footer links to, so it survives a reset of Grafana's data. Visitors need no account and can't open Explore or other dashboards.

The Compose project is called `server` (Docker only accepts lowercase project names), so Docker Desktop lists everything under **server**. Each container has a fixed name, the same as its service apart from `authentik` (the `authentik-server` service): `docker logs grafana`, `docker exec -it authentik-db psql -U authentik`. Those names are set only in `local/` (`compose.yaml` and the two override files); on the VPS Coolify names the containers itself, so the deployed compose files leave them out.

Stop it with `docker compose down`. Data is kept in the volumes (`server_api-db`, which holds the people, and the two above); `docker compose down -v` wipes them. Disk metrics for `/` don't exist on Docker Desktop, so that dashboard panel stays empty locally.

If port 8080 is taken, set `PROXY_PORT` in the same `local/.env`, and change the port in `GRAFANA_URL` and `AUTHENTIK_URL` (`local/monitoring.env`), the four URLs in `local/identity.env` and the issuer and authority in `local/compose.yaml`. The stack expects the five repos as sibling folders.

## Testing the VPS stacks locally

**identity:** the local stack already runs it at `id.localhost:8080` (see above). To run `identity/` on its own, create `identity/.env` with every key from `identity/.env.example` (any values work locally), then run `docker compose up --build -d` in `identity/`. The server only `expose`s 9000, so check it from inside: `docker compose exec authentik-server ak healthcheck`.

**monitoring:** the local stack already runs it (see above). Running `monitoring/` on its own needs SMTP settings and authentik. On Docker Desktop for Windows the `rslave` mount on node-exporter fails and the disk metric for `/` doesn't exist. Both work on a normal Linux VPS. To try the stack locally anyway, override node-exporter's volume with `/:/host:ro` and set `GRAFANA_OAUTH_ENABLED=false`.

## Coolify settings at a glance

| App        | Build pack     | Base directory | Domain (service)                               | Env vars | Volumes                                                      |
| ---------- | -------------- | -------------- | ---------------------------------------------- | -------- | ------------------------------------------------------------ |
| identity   | Docker Compose | `/identity`    | `https://id.<domain>:9000` (authentik-server)  | pipeline | `authentik_db` (back it up), `authentik_data`                |
| monitoring | Docker Compose | `/monitoring`  | `https://grafana.<domain>:3000` (grafana only) | pipeline | `grafana_data`, `prometheus_data`, `loki_data`, `alloy_data` |

## Licence

MIT, see [`LICENSE`](LICENSE). Copyright (c) 2026 TheBensage.
