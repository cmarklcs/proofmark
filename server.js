// Proofmark server: serves the app and relays grading requests to Claude.
// Student grades are never stored here; they stay in each teacher's browser.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("proofmark:" + ACCESS_CODE).digest("hex");
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_IMAGES = 20;

if (!process.env.ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY is not set: grading will fail until it is.");
if (!ACCESS_CODE) console.warn("ACCESS_CODE is not set: anyone with the link can use the app and your API key.");

const client = new Anthropic();
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "40mb" }));

/* ---------- access code ---------- */
const token = () => crypto.createHmac("sha256", SECRET).update("ok").digest("hex");
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function authed(req) {
  if (!ACCESS_CODE) return true;
  const t = cookies(req).pm_auth || "";
  const want = token();
  return t.length === want.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(want));
}
const attempts = new Map(); // ip -> {n, until}
app.get("/api/session", (req, res) => res.json({ ok: authed(req), codeRequired: !!ACCESS_CODE }));
app.post("/api/login", (req, res) => {
  const ip = req.ip || "?";
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ ok: false, message: "Too many tries. Wait a minute." });
  const code = String(req.body?.code || "");
  const ok = ACCESS_CODE && code.length === ACCESS_CODE.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(ACCESS_CODE));
  if (!ok) {
    a.n++; if (a.n >= 8) { a.n = 0; a.until = Date.now() + 60_000; }
    attempts.set(ip, a);
    return res.status(401).json({ ok: false, message: "That code didn't work." });
  }
  attempts.delete(ip);
  res.setHeader("Set-Cookie", `pm_auth=${token()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${req.secure ? "; Secure" : ""}`);
  res.json({ ok: true });
});

/* ---------- Claude relay ---------- */
const EFFORT = { quick: "low", default: "medium", complex: "high" };
app.post("/api/claude", async (req, res) => {
  if (!authed(req)) return res.status(401).json({ code: "not_granted", message: "Enter the access code first." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ code: "sampling_disabled", message: "The server has no Anthropic API key. Set ANTHROPIC_API_KEY." });
  const { prompt, images = [], tier = "default" } = req.body || {};
  if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ code: "invalid_request", message: "Missing prompt." });
  if (!Array.isArray(images) || images.length > MAX_IMAGES) return res.status(400).json({ code: "image_rejected", message: `Up to ${MAX_IMAGES} images per request.` });

  const content = [];
  for (const img of images) {
    const media_type = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(img?.media_type) ? img.media_type : null;
    if (!media_type || typeof img.data !== "string") return res.status(400).json({ code: "image_rejected", message: "Images must be JPEG, PNG, WebP or GIF." });
    content.push({ type: "image", source: { type: "base64", media_type, data: img.data } });
  }
  content.push({ type: "text", text: prompt });

  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      output_config: { effort: EFFORT[tier] || "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    }, { signal: ctl.signal });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") return res.status(422).json({ code: "refused", message: "Claude declined this request." });
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
    if (!text.trim()) return res.status(502).json({ code: "empty_completion", message: "Claude returned no text." });
    res.json({ text, truncated: msg.stop_reason === "max_tokens" });
  } catch (err) {
    if (ctl.signal.aborted) return;
    console.error("Claude request failed:", err?.status, err?.message);
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ code: "rate_limited", message: "Claude is busy. Wait a minute and try again." });
    if (err instanceof Anthropic.AuthenticationError) return res.status(500).json({ code: "sampling_disabled", message: "The server's API key is missing or invalid." });
    if (err instanceof Anthropic.BadRequestError) return res.status(400).json({ code: "invalid_request", message: err.message });
    res.status(502).json({ code: "upstream_error", message: "Couldn't reach Claude. Try again." });
  }
});

/* ---------- static app ---------- */
app.use(express.static(path.join(here, "public"), { extensions: ["html"] }));
app.get("/healthz", (_req, res) => res.send("ok"));
app.listen(PORT, () => console.log(`Proofmark listening on :${PORT}`));
