# Google Sign-In — setup

Google is a second way into the same session the dashboards already use: same
httpOnly cookies, same refresh-token family, same `/auth/me`, same role-based
redirect. Nothing about sessions is forked.

It is **optional and off by default.** With no credentials the sign-in page shows no
Google button at all, and the API answers `503 GOOGLE_SIGNIN_NOT_CONFIGURED` on the
OAuth routes. Everything else — password and OTP login, every dashboard — works.

---

## 1. What you need from Google Cloud

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - App name, support email, developer email
   - Scopes: `openid`, `email`, `profile` (nothing else)
   - While the app is in **Testing**, only accounts you add under *Test users* can
     sign in. Add your own Gmail address to test.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - **Authorised JavaScript origins**
     - `http://localhost:3000` (local)
     - your production origin later, e.g. `https://kabadiwala.app`
   - **Authorised redirect URIs** — this one must match *byte for byte*:
     - `http://localhost:4000/api/v1/auth/google/callback` (local)
     - `https://api.yourdomain.com/api/v1/auth/google/callback` (production)
4. Copy the **Client ID** and **Client secret**.

> The redirect URI points at the **API** (port 4000), not the web app (port 3000).
> Google calls the API back; the API then redirects the browser to the web app.

---

## 2. Put the credentials in `.env`

Open `/home/user/kabadi/.env` and add these four lines at the end — replace the two
values with yours. **Do not commit this file** (it is already in `.gitignore`).

```bash
GOOGLE_CLIENT_ID="1234-abcd.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-xxxxxxxxxxxxxxxx"
GOOGLE_REDIRECT_URI="http://localhost:4000/api/v1/auth/google/callback"
WEB_APP_ORIGIN="http://localhost:3000"
```

Or from a terminal, which also sets the file to mode 600:

```bash
node /tmp/set-google.mjs 'YOUR_CLIENT_ID' 'YOUR_CLIENT_SECRET'
```

Then lock the file down:

```bash
chmod 600 .env
```

**No restart is needed.** `npm run dev:api` now runs
`tsx watch --include ../../.env`, so saving `.env` restarts the API by itself. (That
`--include` exists because it did *not* restart before, and a saved credential that
changes nothing is a confusing half hour.)

### Check it in one command

```bash
npm run google:check
```

It reads your `.env`, calls the running API, and reports every requirement — without
printing the secret. A healthy run ends with:

```
  ok    GOOGLE_CLIENT_ID is set  (72 chars, ends correctly)
  ok    GOOGLE_CLIENT_SECRET is set  (35 chars, value never printed)
  ok    GOOGLE_REDIRECT_URI is the local default  http://localhost:4000/api/v1/auth/google/callback
  ok    API reports google: true  the sign-in page will show the button
  ok    Google redirect begins  host accounts.google.com
  ok    PKCE is sent

  Everything checks out.
```

If it says `API reports google: true, but .env has no GOOGLE_CLIENT_ID`, the running
process is using credentials you have since removed — restart it so that what it uses
matches the file.

The web app needs **no** Google configuration. It asks `/auth/providers` and draws
the button only when `google` is true.

---

## 3. Test it

Open <http://localhost:3000> and click **Continue with Google**.

| What you will see | Why |
|---|---|
| Google's account picker | `prompt=select_account`, so a shared phone does not silently reuse someone else's account |
| **"You are signed in to Google — how do you want to continue?"** | This is the flow you asked for: nothing is created before you choose |
| "Sign in to my existing … account" | Shown only when Google reports the email as **verified** and an account already uses it |
| "Create a new account" → role + mobile number | The role and phone are asked here, not assumed |

---

## 4. How it works, and why

```
Browser → GET /auth/google/start?intent=signup&role=COLLECTOR
           API makes state + PKCE pair, stores them, 302 to Google
Google  → GET /auth/google/callback?code=...&state=...
           API consumes the state (single-use), exchanges the code,
           verifies the id_token, then:
             existing Google link → issue session, 302 to that role's dashboard
             otherwise            → issue NO session, 302 to /auth/google#h=...
Web     → GET /auth/google/pending?h=...     what to show (never the Google sub)
Web     → POST /auth/google/complete  {handle, choice, role, phone}
           "signin" | "link" → issue session
           "signup"          → create account, then issue session
```

Decisions that matter:

- **`state` and PKCE live in the database, single-use.** A state that lives only in a
  cookie can be planted by anyone who can write cookies on a subdomain.
- **The account key is Google's `sub` claim, never the email.** Emails can be
  reassigned inside a Workspace domain; `sub` cannot.
- **Linking requires a verified email.** An unverified address proves nothing about
  who is holding it, so it is never used to attach a Google identity to an existing
  password account.
- **`ADMIN` can never be chosen at signup.** The role is validated against
  `PUBLIC_REGISTRATION_ROLES` on the server.
- **The Google `sub` never reaches the browser.** The chooser sees only name, email,
  whether an account exists, and that account's role.
- **`phone` stays NOT NULL.** A Google sign-up is asked for one at the chooser,
  because a collector has to ring somebody. A nullable phone would have rippled
  into `serializeOwnUserAccount`, OTP login and every screen that assumes one.

---

## 5. Evidence

`apps/api/tests/google-signin.test.ts` — 11 tests, with Google's servers stubbed:
forged signature, wrong audience, expired token, replayed state, unknown person gets
no account, signup requires a phone, `ADMIN` refused, verified-email link offered,
unverified email not offered.

```bash
cd apps/api && npx vitest run tests/google-signin.test.ts
```

**Not tested:** Google's real consent screen. That needs a real client ID and a
human clicking. The flow up to and after it is covered.

---

## 6. If something goes wrong

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` from Google | `GOOGLE_REDIRECT_URI` does not match the console byte for byte |
| `GOOGLE_SIGNIN_NOT_CONFIGURED` | keys missing, or the API was not restarted after adding them |
| `googleMisconfigured: true` | only one of id/secret is set |
| "This took too long" | the 10-minute handle expired — start again |
| Button does not appear | `/auth/providers` says `google: false`; check the API |
| `access_denied` | your Google account is not in *Test users* while the app is in Testing |
