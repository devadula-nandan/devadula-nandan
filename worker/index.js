// Cloudflare Worker behind the portfolio's About chat widget.
//   GET  /api/health → { ok }     cheap config check, never calls Gemini
//   POST /api/chat   → { reply }  Gemini proxy; keeps GOOGLE_API_KEY off the static site

const STATIC_ALLOWED_ORIGINS = new Set([
  'https://nandan-dev.com',
  'https://www.nandan-dev.com',
  'https://devadula-nandan.github.io',
]);

// Matches http://<private-LAN-ip>:<port> so the widget also works when
// testing from a phone on the same Wi-Fi as the dev machine — the LAN IP
// changes across networks/DHCP leases, so a fixed allow-list entry won't do.
const LOCAL_NETWORK_ORIGIN = /^http:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}):\d+$/;

function isAllowedOrigin(origin) {
  return STATIC_ALLOWED_ORIGINS.has(origin) ||
         LOCAL_NETWORK_ORIGIN.test(origin) ||
         /^http:\/\/localhost(:\d+)?$/.test(origin);
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
  if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// Available models ordered from highest to lowest quality
const MODELS_HIERARCHY = [
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

// Helper to determine the fallback chain based on preferred model
function getFallbackChain(preferredModel) {
  const chain = [];
  const idx = MODELS_HIERARCHY.indexOf(preferredModel);
  if (idx !== -1) {
    for (let i = idx; i < MODELS_HIERARCHY.length; i++) {
      chain.push(MODELS_HIERARCHY[i]);
    }
  } else {
    // Default fallback starting point if preferred model is not matched
    chain.push('gemini-3.1-flash-lite');
  }

  // Ensure ultimate fallbacks are included
  const ultimateFallbacks = ['gemini-flash-lite-latest', 'gemini-flash-latest'];
  for (const model of ultimateFallbacks) {
    if (!chain.includes(model)) {
      chain.push(model);
    }
  }
  return chain;
}

const MAX_MSG_LENGTH = 500; // per message
const MAX_TURNS = 12;        // most recent messages kept for context

const SYSTEM_PROMPT = `You are Nandan Devadula's assistant on his personal portfolio site. You speak AS Nandan, in the first person, chatting with a visitor.

Voice and behavior:
- Warm, natural, and conversational — like a friendly professional replying in a chat, not reciting a résumé.
- Keep replies short: usually 1–3 sentences. Expand only when the question genuinely needs it.
- Vary your phrasing. Don't open every reply the same way, and never re-introduce yourself or repeat the greeting once the conversation is underway.
- Use the conversation so far for context: build on what was already asked, refer back to it naturally, and resolve follow-ups like "and before that?" or "why?" against earlier turns. A brief follow-up question of your own is welcome when it fits.
- Write in plain text only — no markdown, bullet characters, or asterisks.

About Nandan:
- Frontend Developer at IBM (Kochi, Kerala, India), on the Carbon Design System team since Nov 2023 — building accessible, enterprise-grade Web Components for Carbon for IBM Products and Carbon for AI, prototyping in Carbon Labs, and doing WCAG accessibility testing (unit, E2E, automated).
- Previously: Software Engineer at HCL Technologies (Jun 2022 – Oct 2023) building financial dashboard UIs and integrating REST APIs; Web UI Developer at Ochre Media (Jul 2021 – May 2022) building B2B microsites.
- Education: B.E. in Electronics & Communication Engineering from Andhra University (Gayatri Vidya Parishad College), plus a Great Learning certificate in full-stack software development.
- Skills: JavaScript, TypeScript, HTML5, CSS/SCSS, React.js, Lit, Redux.js, Web Components, Carbon Design System, Tailwind CSS, Bootstrap, Jest, Cypress, Playwright, REST APIs, MySQL, Python.
- 40+ public GitHub repositories, including wc-audio-input, wc-resizer, and storybook-theme-carbon.
- Contact: devadula.nandan@gmail.com, +91 7032328703. GitHub: github.com/devadula-nandan. LinkedIn: linkedin.com/in/nandan-devadula.

Stay mostly on Nandan's work, skills, and how to reach him, but answer casual or personal questions naturally and in character (e.g. favorite color is Carbon blue, #0f62fe). If something is genuinely unknown or off-limits, say so briefly and steer back — never invent specifics.`;

// Normalize whatever the client sent into Gemini's `contents` format.
// Accepts the new { messages: [{role, content}, ...] } or the legacy { message: "..." }.
function buildContents(body) {
  const raw = Array.isArray(body?.messages)
    ? body.messages
    : body?.message
      ? [{ role: 'user', content: body.message }]
      : [];

  const contents = raw
    .map((m) => {
      const role =
        m && (m.role === 'assistant' || m.role === 'model' || m.role === 'bot')
          ? 'model'
          : 'user';
      const text = String(m?.content ?? m?.text ?? '')
        .slice(0, MAX_MSG_LENGTH)
        .trim();
      return text ? { role, parts: [{ text }] } : null;
    })
    .filter(Boolean)
    .slice(-MAX_TURNS);

  // Gemini requires the conversation to begin with a user turn.
  while (contents.length && contents[0].role !== 'user') contents.shift();
  return contents;
}

async function handleChat(request, env, cors) {
  const body = await request.json().catch(() => ({}));

  const contents = buildContents(body);
  if (!contents.length) {
    return json({ error: 'Empty message' }, 400, cors);
  }

  let reply = null;
  let modelUsed = null;
  let lastError = null;
  const rateLimitedModels = [];

  const fallbackChain = getFallbackChain(body?.preferredModel);

  for (const model of fallbackChain) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GOOGLE_API_KEY}`;
      console.log(`Attempting chat generation with model: ${model}`);
      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: { text: SYSTEM_PROMPT } },
          contents,
          generationConfig: { maxOutputTokens: 400, temperature: 0.75, topP: 0.9 },
        }),
      });

      if (!geminiRes.ok) {
        const errorBody = await geminiRes.text();
        console.warn(`Model ${model} failed with status ${geminiRes.status}: ${errorBody}. Trying next fallback...`);
        lastError = { status: geminiRes.status, body: errorBody };
        rateLimitedModels.push(model);
        continue;
      }

      const data = await geminiRes.json();
      const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (generatedText) {
        reply = generatedText;
        modelUsed = model;
        break; // Success!
      } else {
        console.warn(`Model ${model} returned empty response candidates. Trying next fallback...`);
        lastError = { status: 200, body: 'No candidates returned' };
        rateLimitedModels.push(model);
      }
    } catch (err) {
      console.error(`Error executing model ${model}:`, err?.message);
      lastError = { status: 500, body: err?.message };
      rateLimitedModels.push(model);
    }
  }

  if (!reply) {
    console.error('All models in the fallback chain failed.');
    return json({
      error: 'All Gemini models exhausted',
      details: lastError?.body || 'Unknown error'
    }, lastError?.status >= 400 ? lastError.status : 502, cors);
  }

  return json({ reply, modelUsed, rateLimitedModels }, 200, cors);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: Boolean(env.GOOGLE_API_KEY) }, 200, cors);
    }

    if (pathname === '/api/chat') {
      if (request.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405, cors);
      }
      return handleChat(request, env, cors);
    }

    return json({ error: 'Not found' }, 404, cors);
  },
};
