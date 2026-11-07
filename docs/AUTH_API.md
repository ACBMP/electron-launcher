# Auth API — Design Notes

Notes for the API work supporting login in the launcher. The launcher side is
wired against the endpoints described here (see `main.js` handlers `login`,
`discord-login`, `session-validate`, `logout`), and the API side is implemented
in the `AN-API` repo (`src/app/routes/auth.py`).

Base URL used by the launcher: `https://api.assassins.network` (`API_BASE` in
`main.js`).

> **Status: implemented.** All five endpoints below exist in `AN-API`. The
> **session token is the player's existing `api_key`** — the same Bearer
> credential `require_privilege` already checks — so no separate session store
> was needed. Server needs these env vars set in production: `SECRET_KEY`
> (signs OAuth `state`), `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
> `DISCORD_REDIRECT_URI`.

## Context

- Every player is currently tied to a **Discord ID** and has **no password**.
- So **Discord OAuth is the primary login method.** Username + password is kept
  as a secondary/fallback path (for future accounts, admin/service accounts, or
  players who set a password later). It can ship disabled if we prefer.
- The launcher is a shippable Electron app, so it **cannot hold any secret**
  (Discord client secret, signing keys, etc.). Anything secret stays on the API.

## The core security model (why the flow looks the way it does)

We use the OAuth2 **Authorization Code** grant with a **backend-for-frontend
(BFF)** exchange:

1. The launcher gets Discord to issue an authorization **`code`** (public,
   short-lived, single-use).
2. The launcher hands that `code` to **our API**.
3. The **API** exchanges the code for a Discord access token using the client
   secret, calls Discord for the user's ID, maps it to a player, and returns a
   **session token** of our own.

The Discord access token never reaches the launcher, and the client secret never
leaves the API. The launcher only ever sees `code` and our own session token.

## Sequence

```
Launcher (Electron)          Discord                     Our API
     |                          |                            |
     |  bind 127.0.0.1:8975      |                            |
     |  GET /auth/discord/authorize?redirect_uri=loopback -->|
     |<---------------------- { url, redirectUri, state } ---|
     |                          |                            |
     |  open SYSTEM browser -> url                            |
     |  user approves --------->|                            |
     |<-- 302 http://127.0.0.1:8975/callback?code&state       |
     |  (our loopback listener answers it)                    |
     |                          |                            |
     |  POST /auth/discord/callback { code, state } -------->|
     |                          |   exchange code+secret --->| Discord
     |                          |   GET /users/@me --------->| Discord
     |<------------- { token, username, discordId, ... } ----|
     |  store token in config.json                            |
```

## Endpoints

### `GET /auth/discord/authorize`

Build the Discord consent URL server-side so the launcher hardcodes nothing
(client_id, scopes, and redirect URI all live on the API and can rotate without
a launcher release).

Response:

```json
{
  "url": "https://discord.com/oauth2/authorize?client_id=...&redirect_uri=...&response_type=code&scope=identify&state=...&prompt=none",
  "redirectUri": "https://api.assassins.network/auth/discord/callback",
  "state": "<opaque-csrf-token>"
}
```

- `scope` only needs `identify` (we just need the Discord user ID; add `email`
  only if we actually want it).
- `state` is a CSRF token. Either store it server-side against the pending login
  or make it a signed/stateless value. The launcher echoes it back on callback.
- Pass `?redirect_uri=` to request one of the API's configured loopback URIs
  (`DISCORD_LOOPBACK_REDIRECT_URIS`). Unrecognised values are **ignored, not
  rejected** — the response reports the URI actually used, and callers must read
  it back rather than assume they got what they asked for.
- The chosen URI is signed into `state`, so the token exchange recovers it
  server-side and a client can't swap it afterwards.
- `redirectUri` **must exactly match** a redirect URI registered in the Discord
  developer portal (see below). For the hosted URI the launcher watches for a
  navigation whose URL starts with this value and grabs `code`/`state` from the
  query string — it does **not** need the API to actually render anything for the
  desktop flow.

### `POST /auth/discord/callback`

Exchange the code and issue our session.

Request:

```json
{ "code": "<discord-authorization-code>", "state": "<same-state-as-authorize>" }
```

Server does:

1. Validate `state`.
2. `POST https://discord.com/api/oauth2/token` with
   `client_id`, `client_secret`, `grant_type=authorization_code`, `code`,
   `redirect_uri` (must match the one used in the authorize step).
3. `GET https://discord.com/api/users/@me` with the returned bearer token to get
   the Discord snowflake `id`.
4. Look up the player by that Discord ID.
   - Not found → return 404 carrying a **registration ticket** (see below), so
     the launcher can offer sign-up instead of a dead end. *(Resolved: we do not
     auto-create players; registration is invite-gated.)*
   - Found but `revoked` → reject.
5. Issue a session token and return it.

Response (200):

```json
{
  "token": "<session-token>",
  "username": "PlayerName",
  "discordId": "123456789012345678",
  "expiresAt": "2026-10-01T00:00:00Z"
}
```

Response (404, Discord account valid but no player yet):

```json
{
  "error": "No player is linked to this Discord account",
  "needsRegistration": true,
  "registration": {
    "ticket": "<signed, short-lived registration ticket>",
    "suggestedName": "Discord Display Name"
  }
}
```

Error (4xx): `{ "error": "human-readable reason" }` — the launcher shows
`error` directly.

### `POST /auth/login` (username + password, secondary)

Request: `{ "username": "...", "password": "..." }`

Response (200): `{ "token": "...", "username": "..." }`
Error (401): `{ "error": "Invalid credentials" }`

Notes:
- No players have passwords yet, so this will 401 for everyone until/unless we
  add password support. That's fine — Discord is the real path. We can also just
  return `501`/hide the credential UI if we decide not to support it.
- If we do support it: store passwords with a modern KDF (argon2id or bcrypt),
  never plaintext.

### `GET /auth/session` (validate)

Used by the launcher on startup for silent auto-login.

- Auth: `Authorization: Bearer <token>`
- `200` if the token is valid (optionally return `{ username, discordId }`),
  `401` if not. The launcher only checks the status code today.

### `POST /auth/logout`

- Auth: `Authorization: Bearer <token>`
- Revoke the session server-side (if using opaque/DB-backed sessions). The
  launcher also clears the token locally regardless of the response.

## Session tokens

Two reasonable options:

- **Opaque token + server-side session store** — easy to revoke (needed for a
  real logout), one DB lookup per request. Recommended.
- **JWT** — stateless, but revocation needs a denylist or short TTL + refresh.

Whatever we pick:

- Send it as `Authorization: Bearer <token>` on authed endpoints.
- Give it a sensible TTL. Since this is a launcher people leave installed, either
  use a long TTL or add a refresh mechanism so users aren't re-authing weekly.
- **Migration note:** the existing game/stats endpoints
  (`/players/player/{username}`, `/boards/...`, `/patch/...`) are currently
  unauthenticated and the launcher calls them without a token. If/when we want to
  gate them, they should accept the same `Bearer` session token and the launcher
  should attach it — that wiring is not in place yet.

## Redirect URI strategy

The launcher uses a **loopback redirect (RFC 8252)**: it binds
`http://127.0.0.1:8975/callback`, opens the consent screen in the user's own
browser with `shell.openExternal`, and reads `code`/`state` off the request that
lands on that listener.

This is about the user, not about correctness for its own sake. An Electron
`BrowserWindow` has its own cookie jar, so it never sees the Discord session the
user is already signed in to — the old embedded-window flow made everyone retype
their password and clear 2FA on every single login.

Two things have to line up for it to work:

- `http://127.0.0.1:8975/callback` is registered under **OAuth2 → Redirects** on
  the Discord application. Discord matches redirect URIs exactly, so the port is
  effectively part of the configuration.
- It's in the API's `DISCORD_LOOPBACK_REDIRECT_URIS`. The launcher asks for it via
  `GET /auth/discord/authorize?redirect_uri=...`; anything not allowlisted is
  ignored and the hosted redirect is returned instead.

The launcher **checks which `redirectUri` came back** rather than assuming, and
falls back to the old embedded `BrowserWindow` if it isn't the loopback one — so
an API that doesn't know about loopback redirects, or a machine where port 8975
is already taken, still logs in. Consent in the system browser also means a
closed tab is invisible to the launcher, hence the explicit Cancel button and the
five-minute timeout.

The remaining alternative, if loopback ever proves unworkable:

- **Custom protocol / deep link:** `acblauncher://callback`. Register the scheme
  with the OS (`app.setAsDefaultProtocolClient`) + handle single-instance
  `second-instance` / macOS `open-url`. The most OS-specific plumbing, and RFC
  8252 prefers loopback over it.

Every option keeps the token exchange server-side; only the "how does the code
get back to the app" step differs.

## Discord developer portal setup (what the API owner needs)

1. Create an application at <https://discord.com/developers/applications>.
2. Copy the **Client ID** (public) and **Client Secret** (API-only) into the API
   config/secrets.
3. Under **OAuth2 → Redirects**, add **both**:
   - `https://api.assassins.network/auth/discord/callback` — the hosted redirect,
     used by the embedded-window fallback.
   - `http://127.0.0.1:8975/callback` — the loopback redirect used by the normal
     system-browser flow. Without this, every login silently falls back to the
     in-app window and users have to type their Discord password again.
4. Scopes: `identify` (add `email` only if needed).

## What the launcher stores (client side, `config.json`)

- `username` — current player name (used across launcher pages).
- `token` — our session token; sent as `Bearer` on authed calls.
- `discordId` — set on Discord login (informational).
- `rememberMe` — if true, the launcher attempts silent auto-login on next start;
  logout clears both `token` and `rememberMe`.

**Caveat:** `config.json` is plaintext on disk. A session token there is lower
risk than a password (revocable, expiring), but if we want to harden this later,
Electron's `safeStorage` API can encrypt the token at rest.

## Decisions made in the implementation

1. **Unknown Discord ID on login:** rejected with `404` ("No player is linked to
   this Discord account"). We do **not** auto-create players — accounts are
   created via the existing privileged `/players/add` flow. Revisit if we want
   self-service onboarding.
2. **Password login:** endpoint exists but only succeeds for players with a
   `password_hash` set (checked with werkzeug). Nobody has one today, so it
   returns `401` for everyone until we decide to add passwords — the launcher UI
   keeps the option visible but Discord is the real path.
3. **Session token:** reuse the player's `api_key` (no new token type or store).
   It has no expiry today. `POST /auth/logout` is stateless — the launcher just
   discards the token locally; true server-side revocation would mean rotating
   the `api_key`.
4. **State handling:** signed, stateless `state` via `itsdangerous`
   (`URLSafeTimedSerializer`, 10-minute max age) — no DB round-trip.
5. **Redirect strategy:** embedded-window intercept (launcher default). The API
   also serves a friendly `GET /auth/discord/callback` landing page as a fallback
   if interception ever fails.

Still open:

- Should the token gain a **TTL / refresh**? (Currently long-lived = the api_key.)
- Should authed game/stats endpoints eventually **require** the session token, or
  stay public?

## Registration (implemented, `AN-API` `routes/registration.py` + `routes/invites.py`)

New players had no way in at all before this: the launcher's Register button
opened a website route that redirects to the homepage, Discord login 404'd for
anyone new, and `/auth/login` can't work because no player has a
`password_hash`.

Registration is deliberately split in two so more sign-up methods can be added
without touching account creation:

1. **Identity verification** → a signed *registration ticket* asserting "this
   client controls identity X on provider Y". Today the only issuer is the
   Discord callback above.
2. **Account creation** → `POST /auth/register` trades that ticket, an invite
   code, and the player's profile for a player document and a session.

Adding **username + password** sign-up later means: verify the new identity
however that flow requires, call `issue_registration_ticket("local", ...)`, and
add one handler to `REGISTRATION_PROVIDERS` returning the identity's lookup
query and the fields to store (e.g. `password_hash`). Nothing else changes —
the invite check, profile validation, and player creation are provider-agnostic.

### `POST /auth/register`

```json
{
  "ticket": "<from the identity step>",
  "inviteCode": "ABCD-EFGH",
  "name": "PlayerName",
  "ign": ["InGameName"],
  "nation": "DE",
  "platforms": ["PC"]
}
```

- Returns the same session payload as login, so the launcher goes straight to
  the play screen — no second sign-in.
- `409` if the name is taken (case-insensitive) or the identity already has an
  account; `403` if that identity is revoked; `400` for a bad ticket, bad invite
  code, or invalid profile fields.
- Platform values are normalised to `PC` / `PS3` / `PS4` / `Xbox` (existing
  documents contain messy values like `"PC "`, `"ps4"`, `"PS4;"`).
- New players get `privilege: 10` (least privileged — the scale is inverted).

Supporting endpoints: `GET /auth/register/options` (platform list and field
limits, so the form doesn't hardcode server rules) and
`GET /auth/register/availability?name=` (advisory name check).

### Invite codes — `/invites` (privilege 5)

Sign-up is closed: a code from the Discord server is required.

- `POST /invites/` → mint a code (`maxUses` default 1, optional `expiresInDays`,
  optional `note`). Codes look like `ABCD-EFGH` and omit ambiguous glyphs
  (`0/O`, `1/I/L`) so they survive being retyped from a chat message.
- `GET /invites/` → list codes with usage.
- `POST /invites/<code>/revoke` → disable without deleting, preserving history.

A use is consumed **atomically** by a filtered update that re-checks disabled /
remaining / expiry, so two simultaneous registrations can't both claim the last
use. The use is burned *before* the player insert (the code is the contended
resource) and refunded if the insert fails.

## Launcher updates (implemented, `AN-API` `routes/launcher.py`)

Binaries and the electron-updater feed live on GitHub Releases; this endpoint is
the **policy** layer on top. It gives the launcher an in-app update prompt with
release notes and lets us hard-require an upgrade after a breaking change.

### `GET /launcher/latest[?version=1.0.0]`

Returns `version`, `minimumVersion`, `notes`, `url`, `downloads`. Passing
`version` makes the server evaluate `updateAvailable` and `updateRequired`, so
clients never reimplement version comparison.

**Fails open by design:** if nothing has been published, `minimumVersion` is
`0.0.0`; an unparseable or absent version never sets `updateRequired`. A missing
`launcher` collection must not lock every player out.

### `POST /launcher/latest` (privilege 5)

Publishes `version` / `minimumVersion` / `notes` / `url` / `downloads`. Rejects
a `minimumVersion` newer than `version`, which would demand an upgrade to a
release that doesn't exist.

> Raising `minimumVersion` forces every older launcher to stop playing. Change it
> only alongside a breaking server-side change, and only after that release is
> actually published.

### Automatic announcing

`.github/workflows/announce.yml` POSTs this for you. It fires on GitHub's
`release: published` event — the moment you publish the draft that `release.yml`
built — not when the build finishes, because announcing a draft would point
players at a release page that isn't public yet. It derives `version` from the
tag, condenses the release body into a one-line `notes`, and maps the `.exe` /
`.AppImage` / `.deb` assets into `downloads`.

It **never sends `minimumVersion`** — the endpoint only writes the fields it is
given, so the lockout floor stays a deliberate manual POST.

Setup: add an `AN_API_KEY` repository secret holding an api_key with privilege 5
(optionally `AN_API_URL` as a repo variable to point at a staging API). Without
the secret the job warns and skips rather than failing an otherwise-good release.
Use the workflow's manual "Run workflow" button with a tag to retry or backfill.
