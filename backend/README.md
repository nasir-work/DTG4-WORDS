# Danish pronunciation and account sync backend

This Cloudflare Worker provides Danish text-to-speech and account-based learning progress synchronization. It keeps Gemini credentials on the server and stores generated WAV audio, accounts, sessions, and progress in Workers KV.

## Deploy

1. Install Wrangler and authenticate to your Cloudflare account.
2. From this `backend` folder, create a KV namespace:

   ```powershell
   npx wrangler kv namespace create AUDIO_CACHE
   ```

3. Copy the returned namespace ID into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.
4. Add the Gemini key as a Worker secret (never put it in the HTML or `wrangler.toml`):

   ```powershell
   npx wrangler secret put GEMINI_API_KEY
   ```

5. Deploy:

   ```powershell
   npx wrangler deploy
   ```

The Worker base URL will look like `https://dtg4-pronunciation.<your-workers-subdomain>.workers.dev`.

## Connect the trainer

In the trainer's sidebar, enter the Worker URL ending in `/api/pronunciation`, for example `https://dtg4-pronunciation.<your-workers-subdomain>.workers.dev/api/pronunciation`, and save it. This same Worker URL enables account registration, sign-in, and cloud progress sync. The configured `APP_ORIGIN` must exactly match the site origin (`https://nasir-work.github.io`).

Accounts use email and a 10–128 character password. Passwords are stored as salted PBKDF2 hashes; bearer session tokens are random and stored by hash. Progress is scoped to the signed-in user. The browser retains the token on that device; no password is retained. Changing accounts on one browser clears the previous account's local progress from that browser before loading the new account.

## Speech

`POST /api/pronunciation` accepts `{"text":"..."}` and returns `audio/wav`. Generated audio is cached in KV for one year; simultaneous requests for the same text are coalesced. The Gemini key stays in the Worker secret store. The Worker uses Gemini 3.8 Flash-Lite TTS with the Kore voice. See Google's [Gemini speech generation guide](https://ai.google.dev/gemini-api/docs/speech-generation).

## Account API

- `POST /api/auth/register` with `{email,password}` creates an account and session.
- `POST /api/auth/login` with `{email,password}` returns a session.
- `POST /api/auth/logout` revokes the current bearer session.
- `GET /api/progress` retrieves the authenticated account's progress.
- `PUT /api/progress` stores the authenticated account's progress.

The Worker applies per-IP request limits to account and audio endpoints. Keep backups of the KV namespace if you want independent recovery of accounts and progress.
