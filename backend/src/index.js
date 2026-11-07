const MODEL = "gemini-3.8-flash-lite-tts";
const VOICE = "Kore";
const MAX_TEXT_LENGTH = 500;
const MAX_REQUESTS_PER_MINUTE = 30;
const inflight = new Map();

function cors(origin, allowedOrigin) {
  if (!origin || origin !== allowedOrigin) return {};
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function limitRequest(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rate:${await sha256(`${ip}:${minute}`)}`;
  const count = Number(await env.AUDIO_CACHE.get(key) || 0);
  if (count >= MAX_REQUESTS_PER_MINUTE) return false;
  await env.AUDIO_CACHE.put(key, String(count + 1), { expirationTtl: 120 });
  return true;
}

async function generateAudio(text, env) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      model: env.GEMINI_MODEL || MODEL,
      input: [{
        type: "user_input",
        content: [{
          type: "text",
          text,
          annotations: [{
            type: "speech_metadata",
            style: "Speak in clear, natural standard Danish at a calm language-learning pace. Read only the supplied Danish text verbatim.",
          }],
        }],
      }],
      response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
      generation_config: { speech_config: [{ voice: env.GEMINI_VOICE || VOICE }] },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Gemini TTS failed", response.status, detail.slice(0, 1000));
    throw new Error("Speech generation failed");
  }
  const payload = await response.json();
  const data = payload.output_audio?.data;
  if (typeof data !== "string" || !data) throw new Error("Gemini returned no audio data");
  return data;
}

async function audioFor(text, env) {
  const model = env.GEMINI_MODEL || MODEL;
  const voice = env.GEMINI_VOICE || VOICE;
  const digest = await sha256(`${model}\n${voice}\nda-DK\n${text.normalize("NFC").trim()}`);
  const key = `audio:${digest}`;
  const cached = await env.AUDIO_CACHE.get(key);
  if (cached) return { data: cached, hit: true };

  if (!inflight.has(key)) {
    const pending = generateAudio(text, env).then(async (data) => {
      await env.AUDIO_CACHE.put(key, data, { expirationTtl: 31_536_000 });
      return data;
    }).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return { data: await inflight.get(key), hit: false };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowedOrigin = env.APP_ORIGIN || "https://nasir-work.github.io";
    const headers = cors(origin, allowedOrigin);

    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers });
    }
    if (new URL(request.url).pathname !== "/api/pronunciation") {
      return json({ error: "Not found" }, 404, headers);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
    if (!origin || origin !== allowedOrigin) return json({ error: "Origin not allowed" }, 403);
    if (!env.GEMINI_API_KEY) return json({ error: "Speech service is not configured" }, 503, headers);
    if (!env.AUDIO_CACHE) return json({ error: "Audio cache is not configured" }, 503, headers);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, headers); }
    const text = typeof body.text === "string" ? body.text.normalize("NFC").trim() : "";
    if (!text || text.length > MAX_TEXT_LENGTH || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
      return json({ error: `Text must contain 1–${MAX_TEXT_LENGTH} printable characters` }, 400, headers);
    }
    try {
      if (!await limitRequest(request, env)) return json({ error: "Please wait before requesting more audio" }, 429, headers);
      const { data, hit } = await audioFor(text, env);
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      return new Response(bytes, {
        headers: {
          ...headers,
          "Content-Type": "audio/wav",
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Audio-Cache": hit ? "HIT" : "MISS",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      console.error("Pronunciation error", error);
      return json({ error: "Could not generate pronunciation right now" }, 502, headers);
    }
  },
};

