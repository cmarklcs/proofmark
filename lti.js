// LTI 1.3 tool for Toddle (or any LTI Advantage platform).
// Launch (OIDC + id_token), deep linking, Names & Roles (roster) and
// Assignment & Grade Services (score passback). No student data is stored.
import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8, exportJWK } from "jose";

const C = {
  issuer: process.env.LTI_ISSUER || "",
  clientId: process.env.LTI_CLIENT_ID || "",
  deploymentId: process.env.LTI_DEPLOYMENT_ID || "",
  authUrl: process.env.LTI_AUTH_URL || "",
  jwksUrl: process.env.LTI_JWKS_URL || "",
  tokenUrl: process.env.LTI_TOKEN_URL || "",
  publicUrl: (process.env.PUBLIC_URL || "").replace(/\/$/, ""),
};
const CL = "https://purl.imsglobal.org/spec/lti/claim/";
const AGS = "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint";
const NRPS = "https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice";
const DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";
const SCOPES = {
  lineitem: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
  score: "https://purl.imsglobal.org/spec/lti-ags/scope/score",
  roster: "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
};

export function ltiEnabled() {
  return !!(C.issuer && C.clientId && C.authUrl && C.jwksUrl && C.tokenUrl && C.publicUrl && process.env.LTI_PRIVATE_KEY_B64);
}

/* ---------- tool key ---------- */
let keyP = null;
function toolKey() {
  if (!keyP) keyP = (async () => {
    const pem = Buffer.from(process.env.LTI_PRIVATE_KEY_B64 || "", "base64").toString("utf8");
    const privateKey = await importPKCS8(pem, "RS256", { extractable: true });
    const pub = crypto.createPublicKey(pem);
    const jwk = await exportJWK(pub);
    const kid = crypto.createHash("sha256").update(JSON.stringify([jwk.n, jwk.e])).digest("base64url").slice(0, 16);
    return { privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" }, kid };
  })();
  return keyP;
}

/* ---------- signed session tokens (stateless, survive restarts) ---------- */
export function makeSigner(secret) {
  const sign = data => crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return {
    issue(payload, ttlSec) {
      const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString("base64url");
      return body + "." + sign(body);
    },
    read(tok) {
      if (typeof tok !== "string" || !tok.includes(".")) return null;
      const [body, sig] = tok.split(".");
      const want = sign(body);
      if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
      try { const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); return p.exp > Date.now() / 1000 ? p : null; } catch { return null; }
    },
  };
}

/* ---------- platform access token (client credentials + signed assertion) ---------- */
const tokenCache = new Map();
async function platformToken(scopes) {
  const key = scopes.slice().sort().join(" ");
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  const { privateKey, kid } = await toolKey();
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setIssuer(C.clientId).setSubject(C.clientId).setAudience(C.tokenUrl)
    .setIssuedAt().setExpirationTime("5m").setJti(crypto.randomUUID())
    .sign(privateKey);
  const r = await fetch(C.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion, scope: key }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Toddle token request failed (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
  tokenCache.set(key, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}
async function platformFetch(url, scopes, init = {}) {
  const token = await platformToken(scopes);
  const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: "Bearer " + token } });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) throw new Error(`Toddle returned ${r.status} for ${new URL(url).pathname}: ${String(text).slice(0, 200)}`);
  return { body, headers: r.headers };
}
const withPath = (u, suffix) => { const x = new URL(u); x.pathname = x.pathname.replace(/\/$/, "") + suffix; return x.toString(); };

/* ---------- routes ---------- */
export function mountLti(app, { signer, express }) {
  const pending = new Map(); // state -> {nonce, exp}
  const sweep = () => { const now = Date.now(); for (const [k, v] of pending) if (v.exp < now) pending.delete(k); };
  const jwks = C.jwksUrl ? createRemoteJWKSet(new URL(C.jwksUrl)) : null;
  const form = express.urlencoded({ extended: false });

  app.get("/.well-known/jwks.json", async (_req, res) => {
    if (!process.env.LTI_PRIVATE_KEY_B64) return res.json({ keys: [] });
    const { jwk } = await toolKey(); res.json({ keys: [jwk] });
  });

  app.get("/lti/config", (_req, res) => res.json({
    enabled: ltiEnabled(),
    login_initiation_url: C.publicUrl + "/lti/login",
    redirect_uri: C.publicUrl + "/lti/launch",
    target_link_uri: C.publicUrl + "/lti/launch",
    deep_linking_url: C.publicUrl + "/lti/launch",
    jwks_url: C.publicUrl + "/.well-known/jwks.json",
  }));

  // Step 1: OIDC login initiation from Toddle
  app.all("/lti/login", form, (req, res) => {
    if (!ltiEnabled()) return res.status(503).send("Toddle connection is not configured on this server.");
    const p = { ...req.query, ...(req.body || {}) };
    if (p.iss !== C.issuer) return res.status(400).send("Unknown platform.");
    if (p.client_id && p.client_id !== C.clientId) return res.status(400).send("Unknown client.");
    sweep();
    const state = crypto.randomBytes(18).toString("base64url");
    const nonce = crypto.randomBytes(18).toString("base64url");
    pending.set(state, { nonce, exp: Date.now() + 10 * 60_000 });
    const u = new URL(C.authUrl);
    const q = { scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none", client_id: C.clientId,
      redirect_uri: C.publicUrl + "/lti/launch", login_hint: p.login_hint || "", state, nonce };
    if (p.lti_message_hint) q.lti_message_hint = p.lti_message_hint;
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    res.redirect(302, u.toString());
  });

  // Step 2: launch with the signed id_token
  app.post("/lti/launch", form, async (req, res) => {
    try {
      const { id_token, state } = req.body || {};
      const st = pending.get(state); pending.delete(state);
      if (!st || st.exp < Date.now()) return res.status(400).send("This launch expired. Open Proofmark from Toddle again.");
      const { payload: t } = await jwtVerify(id_token, jwks, { issuer: C.issuer, audience: C.clientId });
      if (t.nonce !== st.nonce) return res.status(400).send("Launch check failed (nonce).");
      if (C.deploymentId && t[CL + "deployment_id"] !== C.deploymentId) return res.status(400).send("Unknown deployment.");
      const roles = t[CL + "roles"] || [];
      const teacher = roles.some(r => /#(Instructor|Administrator|ContentDeveloper)$|\/Instructor|Administrator/.test(r));
      if (!teacher) return res.status(403).send("Proofmark is for teachers. Ask your teacher for your feedback.");
      const type = t[CL + "message_type"];
      if (type === "LtiDeepLinkingRequest") return deepLinkResponse(res, t);
      const ctx = t[CL + "context"] || {};
      const ags = t[AGS] || {};
      const session = signer.issue({
        lti: 1, sub: t.sub, name: t.name || t.given_name || "",
        ctx: { id: ctx.id || "", title: ctx.title || ctx.label || "" },
        link: (t[CL + "resource_link"] || {}).title || "",
        ags: { lineitems: ags.lineitems || "", lineitem: ags.lineitem || "", scope: ags.scope || [] },
        nrps: (t[NRPS] || {}).context_memberships_url || "",
      }, 8 * 3600);
      res.redirect(303, "/?lti=" + encodeURIComponent(session));
    } catch (e) {
      console.error("LTI launch failed:", e.message);
      res.status(400).send("Couldn't verify the launch from Toddle. Open Proofmark from Toddle again.");
    }
  });

  async function deepLinkResponse(res, t) {
    const s = t[DL + "deep_linking_settings"] || {};
    const { privateKey, kid } = await toolKey();
    const jwt = await new SignJWT({
      [CL + "message_type"]: "LtiDeepLinkingResponse",
      [CL + "version"]: "1.3.0",
      [CL + "deployment_id"]: t[CL + "deployment_id"],
      [DL + "data"]: s.data,
      [DL + "content_items"]: [{ type: "ltiResourceLink", title: "Proofmark grading", text: "Grade handwritten work with Proofmark", url: C.publicUrl + "/lti/launch" }],
    }).setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .setIssuer(C.clientId).setAudience(C.issuer).setIssuedAt().setExpirationTime("5m").setJti(crypto.randomUUID())
      .sign(privateKey);
    const esc = v => String(v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Adding Proofmark</title><body onload="document.forms[0].submit()"><form method="post" action="${esc(s.deep_link_return_url)}"><input type="hidden" name="JWT" value="${esc(jwt)}"><noscript><button>Add Proofmark</button></noscript></form></body>`);
  }

  /* ---------- APIs the page calls with its LTI session ---------- */
  const need = (req, res) => { const s = signer.read(req.get("x-lti-session")); if (!s || !s.lti) { res.status(401).json({ message: "Open Proofmark from Toddle again." }); return null; } return s; };

  app.get("/api/lti/context", (req, res) => {
    const s = need(req, res); if (!s) return;
    res.json({ className: s.ctx.title, assignment: s.link, teacher: s.name, canRoster: !!s.nrps, canGrade: !!(s.ags.lineitem || s.ags.lineitems) });
  });

  app.get("/api/lti/roster", async (req, res) => {
    const s = need(req, res); if (!s) return;
    if (!s.nrps) return res.status(400).json({ message: "Turn on roster access for Proofmark in Toddle." });
    try {
      let url = s.nrps, members = [];
      for (let i = 0; url && i < 20; i++) {
        const { body, headers } = await platformFetch(url, [SCOPES.roster], { headers: { accept: "application/vnd.ims.lti-nrps.v2.membershipcontainer+json" } });
        members.push(...(body?.members || []));
        const next = (headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
      }
      const students = members.filter(m => (m.status || "Active") === "Active" && (m.roles || []).some(r => /Learner|Student/i.test(r)))
        .map(m => ({ id: m.user_id, name: m.name || [m.given_name, m.family_name].filter(Boolean).join(" ") || m.user_id, given: m.given_name || "", family: m.family_name || "" }));
      res.json({ students });
    } catch (e) { console.error(e.message); res.status(502).json({ message: "Couldn't read the class list from Toddle. " + e.message }); }
  });

  app.post("/api/lti/scores", async (req, res) => {
    const s = need(req, res); if (!s) return;
    const { label, resourceId, scoreMaximum, scores } = req.body || {};
    if (!Array.isArray(scores) || !scores.length || !(Number(scoreMaximum) > 0)) return res.status(400).json({ message: "Nothing to send." });
    try {
      let lineitem = s.ags.lineitem;
      if (!lineitem) {
        if (!s.ags.lineitems) return res.status(400).json({ message: "Turn on grade passback for Proofmark in Toddle." });
        const found = await platformFetch(s.ags.lineitems + (s.ags.lineitems.includes("?") ? "&" : "?") + "resource_id=" + encodeURIComponent(resourceId || ""), [SCOPES.lineitem], { headers: { accept: "application/vnd.ims.lis.v2.lineitemcontainer+json" } }).catch(() => ({ body: [] }));
        lineitem = (Array.isArray(found.body) ? found.body : []).find(l => l.resourceId === resourceId)?.id;
        if (!lineitem) {
          const made = await platformFetch(s.ags.lineitems, [SCOPES.lineitem], { method: "POST", headers: { "content-type": "application/vnd.ims.lis.v2.lineitem+json", accept: "application/vnd.ims.lis.v2.lineitem+json" },
            body: JSON.stringify({ label: String(label || "Proofmark assessment").slice(0, 200), scoreMaximum: Number(scoreMaximum), resourceId: resourceId || undefined, tag: "proofmark" }) });
          lineitem = made.body?.id;
        }
        if (!lineitem) throw new Error("Toddle didn't return a gradebook column.");
      }
      const results = [];
      for (const sc of scores) {
        try {
          await platformFetch(withPath(lineitem, "/scores"), [SCOPES.score], { method: "POST", headers: { "content-type": "application/vnd.ims.lis.v1.score+json" },
            body: JSON.stringify({ userId: String(sc.userId), scoreGiven: Number(sc.scoreGiven), scoreMaximum: Number(scoreMaximum), comment: sc.comment ? String(sc.comment).slice(0, 4000) : undefined,
              timestamp: new Date().toISOString(), activityProgress: "Completed", gradingProgress: "FullyGraded" }) });
          results.push({ userId: sc.userId, ok: true });
        } catch (e) { results.push({ userId: sc.userId, ok: false, message: e.message }); }
      }
      res.json({ lineitem, results });
    } catch (e) { console.error(e.message); res.status(502).json({ message: "Couldn't send scores to Toddle. " + e.message }); }
  });
}
