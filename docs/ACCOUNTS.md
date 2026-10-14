# Accounts and sign-in

> Provenance: agent-drafted 2026-10-14. Every flow below was run on a
> fresh local D1 (`wrangler dev`) and the hosted deployment the same day:
> first sign-up claimed admin, a second sign-up was refused until open
> registration was on, password and magic-link sign-in, sign-out.

Flare has two kinds of identity. **Accounts** are people: they sign in
to the app, review, approve and administer. **Tokens** are for agents,
runners and scripts: they carry a scope and a repo allow-list and never
log into the app. This page is about accounts; tokens are in
[TOKENS.md](TOKENS.md).

## Signing in

The login screen (`/app?login=1`) offers:

| Door | What happens |
|---|---|
| **Create account** | Email + password. Shown when the deployment has no owner yet, or when the owner turned on open registration. |
| **Sign in** | Email + password. Tries Better Auth first, then the legacy password door for accounts that predate it. |
| **Email me a sign-in link** | A one-time link, 15 minutes, lands on `/app?auth=1` and signs you in. A new address gets an account on first use when registration is open. |
| **Continue with GitHub** | For the owner and the GitHub users on the allow-list (Settings → Team). |
| Invite link | Single-use, 24 hours, minted by the owner in Settings → Team. Works even when registration is closed. |

The **first account** of any kind becomes the owner (admin) of the
deployment; the claim is atomic, so two first sign-ups cannot both win.
Everyone after that is a **member**. A member runs Forge end to end on
the repos they create (app: **+ New repo**, `POST /v1/me/repos`): goals,
intents, trains, plan approval and review. **Connect an agent → Create
my agent token** mints a token bound to the member (scope `member`,
`POST /v1/me/agent-token`) that follows their repos, so a new repo needs
no new token. Members never see Settings, secrets, other accounts'
repos, or the CI executor routes; their agent tokens cannot approve
their own plans (a human session does). Limits: 5 repos and 10 live
agent tokens per account.

**Bring GitHub repos in.** Repos → **Your GitHub repos** lists what
you can import (`GET /v1/me/github-repos`: admins see every repo the
Flare GitHub App can reach; members signed in with GitHub see their own),
and **Bring into Forge** (`POST /v1/me/import`) copies one into
Artifacts, adds `main` (at the default branch tip), the train lane pool
and `refs/notes/why`, and makes you its owner. Any public repo imports
by `owner/name`. Private repos cannot be imported yet: Cloudflare
Artifacts imports public HTTPS remotes only. GitHub
stays the source of truth (coordination mode).

To sign in with GitHub as the owner of an email-claimed deployment, set
**Settings → Team → Owner's GitHub login** (`adminGithubUser`).

## How it is built

Account creation and email sign-in run on
[Better Auth](https://www.better-auth.com), mounted at `/v1/auth/*` on
the Worker and storing its four tables (`auth_user`, `auth_session`,
`auth_account`, `auth_verification`) in the same D1 as everything else.
Better Auth talks to the D1 binding directly; no ORM, no extra database.

Better Auth owns **credentials only**. Authorization stays Flare's:

1. The browser calls `POST /v1/auth/sign-up/email` or
   `/v1/auth/sign-in/email` (or requests a magic link). Better Auth sets
   its own cookie, `flare_auth.session_token`.
2. The browser then calls `POST /v1/admin/auth/bridge`. The Worker asks
   Better Auth who the cookie belongs to and applies the same rules as
   the legacy doors (`bridgeDecision` in `apps/worker/src/better-auth.ts`):
   - a known account → signed in;
   - no owner yet → this account claims admin, exactly like
     `/v1/admin/bootstrap`;
   - otherwise → a member account if open registration is on, else
     `403 registration is closed` with a hint to ask for an invite.
3. The bridge mints the Flare session (cookie `flare_session`, D1
   `sessions`) that every page and API read uses.

Consequences worth knowing:

- An account created through Better Auth has a Flare `users` row with
  an unguessable placeholder password, so the legacy password door
  stays shut for it; it signs in through Better Auth.
- The owner account from before Better Auth has no Better Auth record;
  Sign in falls back to the legacy door for it, and a magic link creates
  the Better Auth record on first use.
- Signing out (`POST /v1/auth/sign-out` and the app's Sign out button)
  clears both cookies.

## Settings that matter

| Setting | Where | Effect |
|---|---|---|
| Open registration | Settings → Team | Shows **Create account** and lets magic links create accounts. Default off. |
| Invites | Settings → Team | Single-use links for teammates when registration is closed. |
| GitHub allow-list | Settings → Team | GitHub users who may use Continue with GitHub. |
| Mail sender | Settings → Notifications (`notify_from_email`) or env `NOTIFY_FROM_EMAIL` | Required for magic links, invites by mail and password resets. Needs the Worker's `EMAIL` send binding. Without it the link request still answers 200 and nothing is sent. |
| Turnstile | Settings → Security | Optional bot check on the legacy login, register and reset routes. |

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/auth/sign-up/email` `{name, email, password}` | none | Create a Better Auth account (password ≥ 8 chars). |
| `POST /v1/auth/sign-in/email` `{email, password}` | none | Sign in; sets `flare_auth.session_token`. |
| `POST /v1/auth/sign-in/magic-link` `{email, callbackURL}` | none | Send a one-time link; `callbackURL` is where the verified link lands (the app uses `/app?auth=1`). |
| `GET /v1/auth/magic-link/verify?token=…` | none | Consumes the link, sets the cookie, redirects. |
| `GET /v1/auth/get-session` | cookie | The Better Auth session, or null. |
| `POST /v1/auth/sign-out` | cookie | Ends the Better Auth session. |
| `POST /v1/admin/auth/bridge` | Better Auth cookie | Mints the Flare session (`{ok, admin}`); 401 without a Better Auth session, 403 when registration is closed. |
| `POST /v1/admin/login`, `/register`, `/bootstrap`, `/magic/request`, `/reset` | none | The legacy doors; still served, same rules. |
| `GET /v1/admin/status` | optional | `claimed`, `openRegistration`, `user {actor, admin}`. The login screen reads this to decide what to show. |

Every route above is in the served OpenAPI spec (`GET /openapi.yaml`,
browse at `/docs`).

## Security notes

- Better Auth rate-limits its own endpoints; the legacy routes throttle
  per email and hashed client IP in D1 (`auth_attempts`).
- Both cookies are `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS.
- Cookie-authenticated mutations are rejected when the `Origin` header
  does not match the deployment; Better Auth checks origins on its own
  routes.
- Better Auth's signing secret is the deployment's secrets key
  (`SECRETS_KEY` env, or the auto-generated D1 key), so a self-hosted
  deploy needs no extra secret.
- Nothing here changes what agents can do: agents use tokens, and a
  token never grants trunk writes (see [FORGE-AGENTS.md](FORGE-AGENTS.md#5-safety-invariants-enforced-here)).
