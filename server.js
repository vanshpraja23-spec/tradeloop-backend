// server.js — TradeLoop backend
// Keeps your Gemini API key secret on the server, and exposes 3 simple
// endpoints for the frontend to call: /api/analyze-chart, /api/chat, /api/build-strategy

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // chart images can be a few MB as base64

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

if (!GEMINI_API_KEY) {
  console.warn('\n⚠️  WARNING: GEMINI_API_KEY is not set. Create a .env file (see .env.example).\n');
}

// ---- Shared helper: call Gemini, return parsed text ----
async function callGemini({ systemInstruction, contents }) {
  const body = {
    system_instruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const resp = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const rawText = await resp.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    // Gemini (or a network/proxy layer in front of it) returned a non-JSON body
    throw new Error(`Gemini returned a non-JSON response (status ${resp.status}): ${rawText.slice(0, 200)}`);
  }

  if (!resp.ok) {
    const message = data?.error?.message || `Gemini API error (status ${resp.status})`;
    throw new Error(message);
  }

  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.map(p => p.text || '').join('') || '';
  const finishReason = candidate?.finishReason;

  if (finishReason === 'MAX_TOKENS') {
    throw new Error('Gemini response got cut off before finishing (ran out of output budget). Try again — if this keeps happening, the response may need to be shorter.');
  }

  if (!text) {
    // Common cause: response was blocked by safety filters
    throw new Error(`No text returned from Gemini${finishReason ? ` (finishReason: ${finishReason})` : ''}`);
  }

  return text;
}

// Strips markdown code fences and parses JSON safely
function parseJsonResponse(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error(`Gemini's response wasn't valid JSON (${e.message}). This usually means the response got cut off — try again.`);
  }
}

// ================= 1. CHART ANALYSIS =================
const ANALYSIS_SYSTEM_PROMPT = `You are Loop, the chart analysis engine inside TradeLoop, a trading psychology and education platform. A retail trader has uploaded a screenshot of a price chart. Analyze it like an experienced, blunt-but-supportive trading mentor.

Respond ONLY with valid JSON (no markdown fences, no preamble) matching exactly this shape:

{
  "instrument_guess": "string - your best guess at the symbol/timeframe visible, or 'Unclear from image' if not visible",
  "trend": { "direction": "uptrend|downtrend|range|unclear", "summary": "1-2 sentences on structure: higher highs/lows etc" },
  "key_levels": [ { "label": "string e.g. Resistance", "price": "string price or description if no price visible", "note": "1 sentence why it matters" } ],
  "patterns": [ { "name": "string e.g. Bearish engulfing", "location": "string e.g. at resistance, candle 3 from right", "implication": "1 sentence" } ],
  "risk_reward": { "setup_visible": true, "comment": "1-2 sentences on what a sensible entry/stop/target structure would look like here, framed as 'if this were your setup' - not as financial advice, always describe in terms of structure (e.g. stop beyond the recent swing low) not certainty" },
  "psychology_flags": [ { "flag": "string e.g. Chasing a breakout candle", "explanation": "1-2 sentences, direct but kind, on the bias/emotion this pattern often reflects" } ],
  "confidence_note": "1-2 sentences honestly stating the limits of reading a single static screenshot - no indicators/volume context, no higher timeframe, can't predict the future",
  "summary": "2-3 sentence plain-language wrap-up a trader would actually read first"
}

Rules:
- Never claim certainty about future price direction. Use language like "suggests", "often signals", "worth watching" — never "will".
- Always include at least one psychology_flags entry, even if it's mild (e.g. "no major red flags - this looks like a patiently planned setup").
- If the image isn't a trading chart, or you genuinely cannot make out chart structure, set trend.direction to "unclear" and explain in summary and confidence_note instead of inventing details.
- Ground every claim in what's visibly in the image. Do not invent price levels you can't see - describe them relatively (e.g. "the swing high from three candles ago") if exact numbers aren't legible.
- Be specific and concrete, never generic filler.`;

app.post('/api/analyze-chart', async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const text = await callGemini({
      systemInstruction: ANALYSIS_SYSTEM_PROMPT,
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType || 'image/png', data: imageBase64 } },
          { text: 'Analyze this trading chart screenshot. Respond only with the JSON object described in your instructions.' },
        ],
      }],
    });

    const parsed = parseJsonResponse(text);
    res.json(parsed);
  } catch (err) {
    console.error('analyze-chart error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to analyze chart' });
  }
});

// ================= 2. CHAT =================
const CHAT_SYSTEM_PROMPT = `You are Loop, the in-app trading mentor for TradeLoop, a platform that helps retail traders improve their performance, discipline, and psychology.

Your voice: direct, warm, never preachy, never robotic. You talk like a sharp trading friend who has seen every mistake in the book (revenge trading, overleveraging, moving stops, FOMO entries, abandoning a strategy after 3 losses) and genuinely wants the person to get better — not someone reciting a textbook.

What you help with: trading psychology, discipline, risk management concepts, position sizing logic, strategy discussion, emotional patterns around losses/wins, habit-building, and general trading education.

Hard rules:
- You are not a financial advisor and never give specific buy/sell signals, specific price predictions, or tell someone to enter/exit a specific real trade right now. If asked, redirect to teaching the underlying decision-making framework instead.
- Never claim certainty about where any market is headed.
- Keep responses conversational and concise by default — a few short paragraphs, not an essay, unless the person asks for depth. Use plain language over jargon; explain jargon when you use it.
- When someone describes a destructive pattern (revenge trading, doubling down after losses, ignoring stop losses, gambling-like behavior), name the pattern honestly and kindly, and help them think through it — don't just validate.
- If someone describes a financial situation that sounds like genuine crisis (e.g. they've lost money they can't afford, mention of self-harm, desperation), prioritize their wellbeing over any trading discussion, and gently encourage them to talk to a real person about it.
- Don't pretend you can remember things outside this conversation.`;

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body; // [{ role: 'user'|'assistant', content: string }]
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Missing messages array' });
    }

    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const text = await callGemini({ systemInstruction: CHAT_SYSTEM_PROMPT, contents });
    res.json({ reply: text });
  } catch (err) {
    console.error('chat error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to get a reply' });
  }
});

// ================= 3. STRATEGY BUILDER =================
const BUILDER_SYSTEM_PROMPT = `You are Loop, the strategy-building engine inside TradeLoop. A retail trader has answered a short questionnaire about their available time, instincts, patience, behavior after losses, risk comfort, experience, and biggest struggle.

Your job: synthesize this into a strategy FRAMEWORK and honest psychological profile suited to who they actually are — not a generic "here's a strategy" answer copy-pasted for everyone.

Respond ONLY with valid JSON (no markdown fences, no preamble) matching exactly this shape:

{
  "trader_archetype": "a short, specific, human label for this trader's profile (e.g. 'The Cautious Swing Trader', 'The Impatient Scalper-in-training') - not generic",
  "psychology_summary": "3-4 sentences giving an honest, kind, specific read on their psychological tendencies based on their answers - name real patterns (e.g. revenge-trading risk, tendency to move stops) if their answers suggest it",
  "recommended_style": { "name": "e.g. Swing trading / Day trading / Position trading", "why": "2-3 sentences on why this style fits their time, patience, and temperament specifically, referencing their actual answers" },
  "core_principles": [ { "title": "short principle name", "detail": "1-2 sentences, concrete and actionable, tailored to their stated weaknesses" } ],
  "risk_framework": { "suggested_max_risk_per_trade": "a sensible conservative percentage range as a string e.g. '0.5%-1% of account per trade'", "comment": "1-2 sentences on position sizing logic suited to their risk comfort and after-loss instincts - if they showed revenge-trading or size-increasing tendencies, address it directly but kindly" },
  "watch_for": [ "string - a specific behavioral trap this exact person is likely to fall into, based on their answers, phrased as a direct heads-up" ],
  "first_steps": [ "string - a concrete, small first action to start building this strategy in practice" ],
  "closing_note": "2-3 encouraging but honest sentences - not generic motivation, something that reflects their specific answers"
}

Rules:
- Never recommend specific instruments, specific entries, or guarantee results.
- If their answers reveal real risk (revenge trading instinct, increasing size after losses, no plan at all), name it clearly and directly in psychology_summary and watch_for - don't soften it into nothing, but stay kind and constructive.
- Be specific to THEIR answers throughout - reference the actual choices they made, not generic trading advice.
- core_principles should have 3-4 items, watch_for should have 2-3 items, first_steps should have 2-3 items.`;

app.post('/api/build-strategy', async (req, res) => {
  try {
    const { answers } = req.body; // { questionText: answerText, ... } or array of {q, a}
    if (!answers) return res.status(400).json({ error: 'Missing answers' });

    const summary = Array.isArray(answers)
      ? answers.map(a => `Q: ${a.q}\nA: ${a.a}`).join('\n\n')
      : Object.entries(answers).map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n\n');

    const text = await callGemini({
      systemInstruction: BUILDER_SYSTEM_PROMPT,
      contents: [{
        role: 'user',
        parts: [{ text: `Here are this trader's answers:\n\n${summary}\n\nGenerate their strategy profile as the JSON object described in your instructions.` }],
      }],
    });

    const parsed = parseJsonResponse(text);
    res.json(parsed);
  } catch (err) {
    console.error('build-strategy error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to build strategy' });
  }
});

// ---- Health check ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, model: MODEL, keyConfigured: Boolean(GEMINI_API_KEY) });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n✅ TradeLoop backend running at http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health\n`);
});
