// Stand-in for the claude.ai runtime when Proofmark runs on its own server.
// sample    -> POST /api/claude (the server holds the API key)
// db        -> this browser's localStorage (nothing about students is stored on the server)
// user      -> a single local user
// downloads -> a normal browser download
"use strict";
window.PROOFMARK_HOSTED = true;
(function () {
  const P = "proofmark:";
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const fail = (code, message) => Promise.reject({ code, message });

  /* ---------- Toddle launch session (LTI) ---------- */
  let LTI = null;
  try { const u = new URL(location.href); const t = u.searchParams.get("lti");
    if (t) { LTI = t; try { sessionStorage.setItem("pm_lti", t); } catch {} u.searchParams.delete("lti"); history.replaceState(null, "", u.pathname + u.search + u.hash); }
    else { try { LTI = sessionStorage.getItem("pm_lti"); } catch {} } } catch {}
  const H = () => (LTI ? { "x-lti-session": LTI } : {});
  let ltiInfo = null; try { ltiInfo = LTI ? JSON.parse(atob(LTI.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))) : null; } catch {}
  const ltiUserId = ltiInfo ? "t" + Array.from(String(ltiInfo.sub)).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36) : "local";
  async function api(path, init = {}) {
    const r = await fetch(path, { ...init, headers: { ...(init.headers || {}), ...H() } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw { message: body.message || "Request failed (" + r.status + ")" };
    return body;
  }
  window.proofmarkLti = LTI ? {
    context: () => api("/api/lti/context"),
    roster: () => api("/api/lti/roster"),
    sendScores: payload => api("/api/lti/scores", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
  } : null;

  /* ---------- access code gate ---------- */
  function overlay(msg) {
    return new Promise(resolve => {
      const show = () => {
        const d = document.createElement("div");
        d.className = "lightbox";
        d.style.background = "var(--paper)";
        d.innerHTML = `<form class="panel stack" style="max-width:380px;width:100%" id="pm-login">
          <h2>Proof<b style="color:var(--accent)">mark</b></h2>
          <p class="muted">Enter the access code your school shared with you.</p>
          <label class="f">Access code<input id="pm-code" type="password" autocomplete="current-password" required></label>
          <div id="pm-err" class="small" style="color:var(--bad)">${msg || ""}</div>
          <button class="btn primary" type="submit">Open Proofmark</button></form>`;
        document.body.appendChild(d);
        d.querySelector("#pm-code").focus();
        d.querySelector("form").addEventListener("submit", async e => {
          e.preventDefault();
          const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: d.querySelector("#pm-code").value }) }).then(r => r.json()).catch(() => ({ ok: false, message: "Couldn't reach the server." }));
          if (r.ok) { d.remove(); resolve(true); } else d.querySelector("#pm-err").textContent = r.message || "That code didn't work.";
        });
      };
      if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
    });
  }
  const ready = fetch("/api/session", { headers: H() }).then(r => r.json()).then(s => s.ok || overlay()).catch(() => overlay("Couldn't reach the server. Check your connection."));

  /* ---------- sample ---------- */
  const toB64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
  async function call(input, opts = {}) {
    const prompt = typeof input === "string" ? input : (input || []).map(t => t.content).join("\n\n");
    const imgs = opts.images ? Array.from(opts.images instanceof Blob ? [opts.images] : opts.images) : [];
    let images;
    try { images = await Promise.all(imgs.map(async b => ({ media_type: b.type || "image/jpeg", data: await toB64(b) }))); }
    catch { return fail("image_rejected", "Couldn't read an image."); }
    if (opts.signal?.aborted) return fail("cancelled", "Cancelled");
    let r;
    try {
      r = await fetch("/api/claude", { method: "POST", headers: { "content-type": "application/json", ...H() }, body: JSON.stringify({ prompt, images, tier: opts.modelTier || "default" }), signal: opts.signal });
    } catch (e) {
      return fail(e && e.name === "AbortError" ? "cancelled" : "upstream_error", "Network error");
    }
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) { if (LTI) return fail("session_expired", "Open Proofmark from Toddle again."); overlay("Your session ended. Enter the code again."); return fail("session_expired", "Sign in again"); }
    if (!r.ok) return fail(body.code || "upstream_error", body.message || "Request failed");
    if (opts.onText) try { opts.onText({ text: body.text, delta: body.text }); } catch {}
    return { text: body.text, truncated: !!body.truncated, modelTierApplied: opts.modelTier || "default" };
  }
  function parseJson(t) {
    try { return JSON.parse(t); } catch {}
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) try { return JSON.parse(f[1]); } catch {}
    const a = t.search(/[{[]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) try { return JSON.parse(t.slice(a, b + 1)); } catch {}
    throw { code: "invalid_json", message: "Reply was not JSON", text: t };
  }
  const sample = (input, opts) => call(input, opts);
  sample.json = async (input, opts) => { const r = await call(input, opts); if (r.truncated) throw { code: "invalid_json", message: "Cut short", text: r.text }; return parseJson(r.text); };
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 20, maxInputBytes: 20 * 1024 * 1024, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] }, modelTiers: ["default", "complex", "quick"] });

  /* ---------- db (localStorage) ---------- */
  const store = { get(k) { try { return localStorage.getItem(P + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(P + k, v); } catch (e) { throw { code: "quota_exceeded", message: "This browser's storage is full." }; } },
    del(k) { try { localStorage.removeItem(P + k); } catch {} },
    keys() { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(P)) out.push(k.slice(P.length)); } } catch {} return out; } };
  const meta = { fromCache: false, hasPendingWrites: false };
  const snap = (id, raw) => ({ id, exists: raw != null, data: () => (raw == null ? undefined : JSON.parse(raw)), metadata: meta });
  function docRef(p) {
    const id = p.split("/").pop();
    return { id, path: p,
      get: async () => snap(id, store.get(p)),
      set: async d => store.set(p, JSON.stringify(d)),
      update: async d => { const cur = store.get(p); if (cur == null) throw { code: "invalid_argument", message: "No such document" }; store.set(p, JSON.stringify({ ...JSON.parse(cur), ...d })); },
      delete: async () => store.del(p),
      onSnapshot(next) { setTimeout(() => next(snap(id, store.get(p)))); return () => {}; },
      collection: c => colRef(p + "/" + c) };
  }
  function colRef(p) {
    const list = () => { const pre = p + "/"; const docs = store.keys().filter(k => k.startsWith(pre) && !k.slice(pre.length).includes("/")).sort().map(k => snap(k.slice(pre.length), store.get(k))); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta }; };
    const q = { get: async () => list(), where: () => q, orderBy: () => q, limit: () => q, onSnapshot(next) { setTimeout(() => next(list())); return () => {}; } };
    return { ...q, path: p, doc: id => docRef(p + "/" + (id || rid())), add: async d => { const r = docRef(p + "/" + rid()); await r.set(d); return r; } };
  }
  const db = { doc: docRef, collection: colRef };

  /* ---------- user, downloads ---------- */
  const user = { id: async () => ltiUserId, me: async () => ({ id: ltiUserId, name: (ltiInfo && ltiInfo.name) || "" }), isOwner: () => true, canEdit: () => true, can: () => true, profiles: async () => ({}) };
  const downloads = { save: async ({ filename, data }) => {
    const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? "text/csv" : /\.html?$/i.test(filename) ? "text/html" : "application/octet-stream" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000); return { status: "saved" };
  } };

  const caps = { sample, db, user, downloads };
  window.claude = { use: async name => { await ready; return caps[name] || null; } };
})();
