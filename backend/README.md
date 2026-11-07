# Danish pronunciation backend

This Cloudflare Worker calls Gemini TTS, keeps the Gemini key on the server, caches generated WAV audio in Workers KV for one year, coalesces simultaneous requests for the same phrase, and applies a per-IP request limit.

## Deploy

1. Install Wrangler and log in to your Cloudflare account.
2. From this `backend` folder, create the cache namespace:

   ```powershell
   npx wrangler kv namespace create AUDIO_CACHE
   ```

3. Copy the returned namespace ID into `wrangler.toml` in place of `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.
4. Add the Gemini key as a Worker secret. Never put it in the HTML or `wrangler.toml`:

   ```powershell
   npx wrangler secret put GEMINI_API_KEY
   ```

5. Deploy:

   ```powershell
   npx wrangler deploy
   ```

The API endpoint will be `https://dtg4-pronunciation.<your-workers-subdomain>.workers.dev/api/pronunciation`.

## Connect the page

In the trainer HTML, set `PRONUNCIATION_API_URL` near the start of the app script to the deployed endpoint. Save and publish the page again. The endpoint accepts `POST {"text":"..."}` and returns `audio/wav`. Only the exact GitHub Pages origin configured in `APP_ORIGIN` is allowed by CORS.

Gemini currently supports Danish TTS. The worker uses Gemini 3.8 Flash-Lite TTS with the Kore voice. See Google's [Gemini speech generation guide](https://ai.google.dev/gemini-api/docs/speech-generation).

