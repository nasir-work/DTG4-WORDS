const MODEL = "gemini-3.8-flash-lite-tts";
const VOICE = "Kore";
const MAX_TEXT_LENGTH = 500;
const MAX_AUDIO_REQUESTS_PER_MINUTE = 30;
const MAX_AUTH_REQUESTS_PER_MINUTE = 12;
const PBKDF2_ITERATIONS = 210_000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const inflightAudio = new Map();

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function cors(origin, allowedOrigin) {
  if (!origin || origin !== allowedOrigin) return {};
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, 256);
  return base64(new Uint8Array(bits));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function rateLimit(request, env, bucket, limit) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rate:${bucket}:${await sha256(`${ip}:${minute}`)}`;
  const count = Number(await env.AUDIO_CACHE.get(key) || 0);
  if (count >= limit) return false;
  await env.AUDIO_CACHE.put(key, String(count + 1), { expirationTtl: 120 });
  return true;
}

async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 120_000) throw new Error("Request too large");
  return request.json();
}

async function issueSession(user, env) {
  const token = randomToken();
  const sessionKey = `session:${await sha256(token)}`;
  await env.AUDIO_CACHE.put(sessionKey, JSON.stringify({ userId: user.id, email: user.email }), { expirationTtl: SESSION_TTL_SECONDS });
  return { token, user: { email: user.email } };
}

async function authenticatedUser(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token || token.length > 200) return null;
  const session = await env.AUDIO_CACHE.get(`session:${await sha256(token)}`);
  return session ? JSON.parse(session) : null;
}

async function handleRegister(request, env) {
  if (!await rateLimit(request, env, "auth", MAX_AUTH_REQUESTS_PER_MINUTE)) return json({ error: "Too many account requests; try again shortly" }, 429);
  let body;
  try { body = await readJson(request); } catch { return json({ error: "Invalid or oversized request" }, 400); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: "Enter a valid email address" }, 400);
  if (password.length < 10 || password.length > 128) return json({ error: "Password must be 10–128 characters" }, 400);

  const id = await sha256(email);
  const userKey = `user:${id}`;
  if (await env.AUDIO_CACHE.get(userKey)) return json({ error: "An account with that email already exists" }, 409);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const user = { id, email, salt: base64(salt), passwordHash: await passwordHash(password, salt), iterations: PBKDF2_ITERATIONS };
  await env.AUDIO_CACHE.put(userKey, JSON.stringify(user));
  return json(await issueSession(user, env), 201);
}

async function handleLogin(request, env) {
  if (!await rateLimit(request, env, "auth", MAX_AUTH_REQUESTS_PER_MINUTE)) return json({ error: "Too many login attempts; try again shortly" }, 429);
  let body;
  try { body = await readJson(request); } catch { return json({ error: "Invalid request" }, 400); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password || email.length > 254 || password.length > 128) return json({ error: "Email or password is incorrect" }, 401);
  const id = await sha256(email);
  const stored = await env.AUDIO_CACHE.get(`user:${id}`);
  if (!stored) return json({ error: "Email or password is incorrect" }, 401);
  const user = JSON.parse(stored);
  const salt = Uint8Array.from(atob(user.salt), (char) => char.charCodeAt(0));
  const candidate = await passwordHash(password, salt);
  if (!constantTimeEqual(candidate, user.passwordHash)) return json({ error: "Email or password is incorrect" }, 401);
  return json(await issueSession(user, env));
}

async function handleProgress(request, env) {
  const user = await authenticatedUser(request, env);
  if (!user) return json({ error: "Please sign in again" }, 401);
  const key = `progress:${user.userId}`;
  if (request.method === "GET") {
    const saved = await env.AUDIO_CACHE.get(key);
    return json({ progress: saved ? JSON.parse(saved) : null });
  }
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
  let body;
  try { body = await readJson(request); } catch { return json({ error: "Invalid or oversized progress data" }, 400); }
  const progress = body.progress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress) || !progress.cards || typeof progress.cards !== "object") {
    return json({ error: "Invalid progress data" }, 400);
  }
  const cards = Object.entries(progress.cards).slice(0, 700);
  const safeProgress = {
    cards: Object.fromEntries(cards),
    streak: Math.max(0, Math.min(100_000, Number(progress.streak) || 0)),
    lastDay: typeof progress.lastDay === "string" ? progress.lastDay.slice(0, 32) : "",
    currentWord: typeof progress.currentWord === "string" ? progress.currentWord.slice(0, 160) : "",
    updatedAt: Math.max(0, Number(progress.updatedAt) || 0),
  };
  const serialized = JSON.stringify(safeProgress);
  if (serialized.length > 100_000) return json({ error: "Progress data is too large" }, 413);
  await env.AUDIO_CACHE.put(key, serialized);
  return json({ saved: true, updatedAt: safeProgress.updatedAt });
}

async function generateAudio(text, env) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      model: env.GEMINI_MODEL || MODEL,
      input: [{ type: "user_input", content: [{
        type: "text", text,
        annotations: [{ type: "speech_metadata", style: "Speak in clear, natural standard Danish at a calm language-learning pace. Read only the supplied Danish text verbatim." }],
      }] }],
      response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
      generation_config: { speech_config: [{ voice: env.GEMINI_VOICE || VOICE }] },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error("Gemini TTS failed", response.status, detail.slice(0, 1000));
    throw new Error("Speech generation failed");
  }
  const data = (await response.json()).output_audio?.data;
  if (typeof data !== "string" || !data) throw new Error("Gemini returned no audio data");
  return data;
}

async function audioFor(text, env) {
  const digest = await sha256(`${env.GEMINI_MODEL || MODEL}\n${env.GEMINI_VOICE || VOICE}\nda-DK\n${text.normalize("NFC").trim()}`);
  const key = `audio:${digest}`;
  const cached = await env.AUDIO_CACHE.get(key);
  if (cached) return { data: cached, hit: true };
  if (!inflightAudio.has(key)) {
    const pending = generateAudio(text, env).then(async (data) => {
      await env.AUDIO_CACHE.put(key, data, { expirationTtl: 31_536_000 });
      return data;
    }).finally(() => inflightAudio.delete(key));
    inflightAudio.set(key, pending);
  }
  return { data: await inflightAudio.get(key), hit: false };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowedOrigin = env.APP_ORIGIN || "https://nasir-work.github.io";
    const headers = cors(origin, allowedOrigin);
    const path = new URL(request.url).pathname;

    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers });
    }
    if (!origin || origin !== allowedOrigin) return json({ error: "Origin not allowed" }, 403);
    if (!env.AUDIO_CACHE) return json({ error: "Storage is not configured" }, 503, headers);

    try {
      if (path === "/api/auth/register" && request.method === "POST") return await handleRegister(request, env).then((r) => withHeaders(r, headers));
      if (path === "/api/auth/login" && request.method === "POST") return await handleLogin(request, env).then((r) => withHeaders(r, headers));
      if (path === "/api/auth/logout" && request.method === "POST") {
        const auth = request.headers.get("Authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (token) await env.AUDIO_CACHE.delete(`session:${await sha256(token)}`);
        return json({ loggedOut: true }, 200, headers);
      }
      if (path === "/api/progress") return await handleProgress(request, env).then((r) => withHeaders(r, headers));
      if (path !== "/api/pronunciation") return json({ error: "Not found" }, 404, headers);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
      if (!env.GEMINI_API_KEY) return json({ error: "Speech service is not configured" }, 503, headers);
      if (!await rateLimit(request, env, "audio", MAX_AUDIO_REQUESTS_PER_MINUTE)) return json({ error: "Please wait before requesting more audio" }, 429, headers);
      let body;
      try { body = await readJson(request); } catch { return json({ error: "Invalid request" }, 400, headers); }
      const text = typeof body.text === "string" ? body.text.normalize("NFC").trim() : "";
      if (!text || text.length > MAX_TEXT_LENGTH || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return json({ error: `Text must contain 1–${MAX_TEXT_LENGTH} printable characters` }, 400, headers);
      const { data, hit } = await audioFor(text, env);
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      return new Response(bytes, { headers: { ...headers, "Content-Type": "audio/wav", "Cache-Control": "public, max-age=31536000, immutable", "X-Audio-Cache": hit ? "HIT" : "MISS", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      console.error("Trainer API error", error);
      return json({ error: "The request could not be completed" }, 502, headers);
    }
  },
};

function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, { status: response.status, headers: merged });
}
