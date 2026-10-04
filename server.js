import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import filepath from 'node:url';
import path from 'node:path';

const __filename = filepath.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// This line lets Express serve style.css, main.js, index.html, etc.
app.use(express.static(__dirname));
app.use(express.json());

if (!process.env.ANTHROPIC_API_KEY) console.warn("Warning: ANTHROPIC_API_KEY is missing from .env. AI routes will fail.");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "missing" });


app.use(express.json({ limit: "10mb" }));

/* Serve only the public folders. Never serve "." because that would expose .env */
app.use("/css", express.static(path.join(__dirname, "css")));
app.use("/js", express.static(path.join(__dirname, "js")));
app.use("/models", express.static(path.join(__dirname, "models")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

/* ---------- Helpers ---------- */
function limit(max = 20, windowMs = 60_000) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const recent = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
    recent.push(now); hits.set(req.ip, recent); next();
  };
}

const LANGS = { en: "English", hi: "Hindi", bn: "Bengali", ta: "Tamil", te: "Telugu", mr: "Marathi", gu: "Gujarati", kn: "Kannada", ml: "Malayalam", pa: "Punjabi" };
const langName = (code) => LANGS[code] || "English";
const textOf = (msg) => msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");

function parseJson(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("Model did not return JSON");
  return JSON.parse(text.slice(s, e + 1));
}

const distKm = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

/* ---------- 1. Photo diagnosis ---------- */
const diagSystem = (lang) => `You are a careful roadside safety assistant for Maruti Suzuki drivers in India.
Look at the photo (a dashboard warning light, breakdown, damage, or accident) and reply with JSON only, no other text:
{"problem": "short name", "urgency": "low|medium|high", "explanation": "1-2 plain sentences", "steps": ["up to 5 short steps"]}
Rules:
- Write problem, explanation and steps in ${langName(lang)}. Keep the urgency value exactly low, medium or high in English.
- Mark urgency high for brakes, oil pressure, engine temperature, airbag, smoke, fire, fuel leak or any accident with injuries, and tell the driver to stop safely and call for help.
- If the image doesn't show a vehicle issue, say so in "problem" and ask for a clearer photo.
- You can't inspect the car, so don't claim certainty. Recommend a Suzuki service centre when in doubt.`;

app.post("/api/diagnose", limit(), async (req, res) => {
  try {
    const { image, mediaType = "image/jpeg", carModel = "", description = "", language = "en" } = req.body;
    if (typeof image !== "string" || !image) return res.status(400).json({ error: "Missing image" });
    if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) return res.status(400).json({ error: "Unsupported image type" });
    const msg = await client.messages.create({
      model: MODEL, max_tokens: 900, system: diagSystem(language),
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
        { type: "text", text: `Car: ${String(carModel).slice(0, 60) || "unknown"}. Driver says: ${String(description).slice(0, 400) || "nothing"}. Diagnose.` },
      ] }],
    });
    const d = parseJson(textOf(msg));
    res.json({
      problem: String(d.problem || "Unclear"),
      urgency: ["low", "medium", "high"].includes(d.urgency) ? d.urgency : "medium",
      explanation: String(d.explanation || ""),
      steps: Array.isArray(d.steps) ? d.steps.slice(0, 6).map(String) : [],
    });
  } catch (err) { console.error("diagnose:", err.message); res.status(500).json({ error: "Diagnosis failed" }); }
});

/* ---------- 2. Follow-up chat ---------- */
app.post("/api/chat", limit(), async (req, res) => {
  try {
    const { messages, diagnosis, language = "en" } = req.body;
    if (!Array.isArray(messages)) return res.status(400).json({ error: "Missing messages" });
    let clean = messages.slice(-12)
      .filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));
    while (clean.length && clean[0].role !== "user") clean.shift();
    if (!clean.length) return res.status(400).json({ error: "No user message" });
    const msg = await client.messages.create({
      model: MODEL, max_tokens: 500,
      system: `You are a calm roadside safety assistant for Maruti Suzuki drivers. Answer briefly in ${langName(language)}, in plain words, at most 4 sentences.
If anything could be dangerous, tell the driver to stop somewhere safe and call roadside assistance or 112. Never promise a car is safe to drive.
Earlier diagnosis for context: ${JSON.stringify(diagnosis || {}).slice(0, 1500)}`,
      messages: clean,
    });
    res.json({ reply: textOf(msg) });
  } catch (err) { console.error("chat:", err.message); res.status(500).json({ error: "Chat failed" }); }
});

/* ---------- 3. AI accident report draft ---------- */
app.post("/api/report", limit(5), async (req, res) => {
  try {
    const { type = "accident", note = "", lat, lng, time, diagnosis, language = "en" } = req.body;
    const msg = await client.messages.create({
      model: MODEL, max_tokens: 700,
      system: `You write a factual first-draft incident report for a driver in India, in ${langName(language)}.
Use only the details given. Write "Not provided" for anything missing. Never invent names, plate numbers, injuries or fault.
Sections: Summary, Time and location, What happened, Vehicle condition, Immediate next steps. End with: "Draft only. Check every detail before sharing with insurance or police."`,
      messages: [{ role: "user", content: JSON.stringify({ type, note: String(note).slice(0, 500), lat, lng, time, diagnosis }) }],
    });
    res.json({ summary: textOf(msg) });
  } catch (err) { console.error("report:", err.message); res.status(500).json({ error: "Report failed" }); }
});

/* ---------- 4. Shared accident alerts (in memory) with live push ---------- */
const TYPES = ["accident", "breakdown", "hazard", "flood", "sos", "crash"];
const MAX_AGE = 2 * 60 * 60 * 1000;
const alerts = [];
const clients = new Set();

function prune() {
  const cutoff = Date.now() - MAX_AGE;
  while (alerts.length && alerts[0].time < cutoff) alerts.shift();
  while (alerts.length > 500) alerts.shift();
}

const parsePos = (q) => {
  const lat = parseFloat(q.lat), lng = parseFloat(q.lng), radius = parseFloat(q.radius) || 5;
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, radius } : null;
};

app.get("/api/alerts", (req, res) => {
  prune();
  const p = parsePos(req.query);
  res.json(p ? alerts.filter((a) => distKm(p, a) <= p.radius) : alerts);
});

app.post("/api/alerts", limit(10), (req, res) => {
  const { type, note = "", lat, lng } = req.body;
  if (!TYPES.includes(type)) return res.status(400).json({ error: "Unknown alert type" });
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: "Bad location" });
  const alert = { id: crypto.randomUUID(), type, note: String(note).slice(0, 200), lat, lng, time: Date.now() };
  alerts.push(alert); prune();
  for (const c of clients) if (distKm(c, alert) <= c.radius) c.res.write(`data: ${JSON.stringify(alert)}\n\n`);
  res.status(201).json(alert);
});

/* Live push: the page opens new EventSource("/api/alerts/stream?lat=..&lng=..&radius=..") */
app.get("/api/alerts/stream", (req, res) => {
  const p = parsePos(req.query);
  if (!p) return res.status(400).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const client = { ...p, res };
  clients.add(client);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(ping); clients.delete(client); });
});

app.listen(PORT, () => console.log(`AetherDrive running at http://localhost:${PORT}`));