"use strict";
// Dhun server: zero dependencies, Node 18+. Run: node server.js
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = +process.env.PORT || 3000, DEV = process.env.NODE_ENV !== "production";
const ROOT = __dirname, DATA = path.join(ROOT, "data"), DBF = path.join(DATA, "db.json"), PUB = path.join(ROOT, "public"), MEDIA = path.join(ROOT, "media");
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });

/* ---------- storage (single JSON file; swap for Postgres/SQLite when you outgrow it) ---------- */
let db = { users: {}, otps: {}, plays: {}, secret: crypto.randomBytes(32).toString("hex") };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DBF, "utf8")) }; } catch {}
const save = () => { fs.writeFileSync(DBF + ".tmp", JSON.stringify(db)); fs.renameSync(DBF + ".tmp", DBF); };
let sT; const saveSoon = () => { clearTimeout(sT); sT = setTimeout(save, 1000); };
save();
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { save(); process.exit(0); });
const SECRET = process.env.SESSION_SECRET || db.secret;
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://appassets.androidplatform.net,http://appassets.androidplatform.net").split(",");

const tracks = () => JSON.parse(fs.readFileSync(path.join(ROOT, "tracks.json"), "utf8")).map(t => {
  const f = t.file && path.basename(t.file);
  return { ...t, file: f && fs.existsSync(path.join(MEDIA, f)) ? "/media/" + f : null };
});

/* ---------- helpers ---------- */
const bad = (m, c = 400) => { throw Object.assign(new Error(m), { code: c }); };
const send = (res, c, o) => { res.writeHead(c, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
const body = req => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on("data", d => { n += d.length; if (n > 2e5) { no(Object.assign(new Error("Body too large"), { code: 413 })); req.destroy(); } else c.push(d); });
  req.on("end", () => { try { ok(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch { no(Object.assign(new Error("Invalid JSON"), { code: 400 })); } });
});
const hits = new Map();
const limit = (req, max) => { const k = req.socket.remoteAddress, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < 6e4); a.push(now); hits.set(k, a); if (a.length > max) bad("Too many requests. Slow down.", 429); };
const hash = s => crypto.createHash("sha256").update(s + SECRET).digest("hex");
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString("base64url"); return b + "." + crypto.createHmac("sha256", SECRET).update(b).digest("base64url"); };
const unsign = t => { try { const [b, s] = String(t).split("."); const e = crypto.createHmac("sha256", SECRET).update(b).digest("base64url"); if (!s || !eq(s, e)) return null; const p = JSON.parse(Buffer.from(b, "base64url")); return p.exp > Date.now() ? p : null; } catch { return null; } };
const me = req => { const p = unsign((req.headers.authorization || "").slice(7)); return p && db.users[p.sub] || null; };
const phoneOf = v => { const p = String(v || "").replace(/[\s-]/g, ""); if (!/^\+?\d{8,15}$/.test(p)) bad("Enter a valid mobile number"); return p; };
async function sendSms(phone, otp) {
  if (process.env.SMS_WEBHOOK) { const r = await fetch(process.env.SMS_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, message: `Your Dhun code is ${otp}` }) }); if (!r.ok) bad("Could not send OTP", 502); }
  else if (DEV) console.log(`[dev] OTP for ${phone}: ${otp}`);
  else bad("SMS provider not configured (set SMS_WEBHOOK)", 503);
}

/* ---------- API ---------- */
const routes = []; const R = (m, p, h, auth) => routes.push([m, new RegExp("^" + p.replace(/:\w+/g, "([^/]+)") + "$"), h, auth]);
const TREND = ["t3", "t7", "t11", "t5", "t1", "t9"];
const want = h => h < 11 ? ["Devotional", "Hindi"] : h < 17 ? ["Pop", "Punjabi", "Tamil"] : h < 21 ? ["Punjabi", "Hindi", "Pop"] : ["Lo-fi", "Devotional"];

R("GET", "/api/health", () => ({ ok: true, tracks: tracks().length }));
R("GET", "/api/tracks", ({ url }) => {
  const q = (url.searchParams.get("q") || "").toLowerCase().slice(0, 80), lang = url.searchParams.get("lang") || "All";
  return { tracks: tracks().filter(t => (lang === "All" || t.lang === lang) && (!q || `${t.title} ${t.artist} ${t.lang}`.toLowerCase().includes(q))) };
});
R("GET", "/api/langs", () => ({ langs: ["All", ...new Set(tracks().map(t => t.lang))] }));
R("GET", "/api/trending", () => {
  const T = tracks(), rank = t => TREND.indexOf(t.id) < 0 ? 99 : TREND.indexOf(t.id);
  return { tracks: [...T].sort((a, b) => (db.plays[b.id] || 0) - (db.plays[a.id] || 0) || rank(a) - rank(b)).slice(0, 6) };
});
R("POST", "/api/tracks/:id/play", ({ m }) => { if (!tracks().some(t => t.id === m[1])) bad("Unknown track", 404); db.plays[m[1]] = (db.plays[m[1]] || 0) + 1; saveSoon(); return { ok: true }; });
R("GET", "/api/recommendations", ({ url, u }) => {
  const T = tracks(), h = +url.searchParams.get("hour"), hh = h >= 0 && h < 24 ? h : new Date().getHours(), H = u ? u.hist : {}, by = {};
  for (const [i, n] of Object.entries(H)) { const t = T.find(x => x.id === i); if (t) by[t.lang] = (by[t.lang] || 0) + n; }
  const fav = Object.entries(by).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  const sc = t => (want(hh).includes(t.lang) ? 2 : 0) + (t.lang === fav[0] ? 3 : 0) + (fav.includes(t.lang) ? 1 : 0) - (H[t.id] || 0) * .3 + (db.plays[t.id] || 0) * .01;
  return { ids: [...T].sort((a, b) => sc(b) - sc(a)).slice(0, 6).map(t => t.id) };
});
R("POST", "/api/auth/otp", async ({ req }) => {
  limit(req, 10); const p = phoneOf((await body(req)).phone), o = db.otps[p] || { sent: [] };
  o.sent = o.sent.filter(t => Date.now() - t < 36e5); if (o.sent.length >= 5) bad("Too many OTP requests. Try again in an hour.", 429);
  const otp = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
  db.otps[p] = { h: hash(otp), exp: Date.now() + 3e5, tries: 0, sent: [...o.sent, Date.now()] }; save();
  await sendSms(p, otp); return DEV ? { ok: true, devOtp: otp } : { ok: true };
});
R("POST", "/api/auth/verify", async ({ req }) => {
  limit(req, 20); const b = await body(req), p = phoneOf(b.phone), o = db.otps[p];
  if (!o || o.exp < Date.now()) bad("OTP expired. Request a new one.");
  if (++o.tries > 5) { delete db.otps[p]; save(); bad("Too many attempts. Request a new OTP.", 429); }
  if (!eq(hash(String(b.otp || "")), o.h)) { save(); bad("Wrong OTP"); }
  delete db.otps[p];
  const u = db.users[p] || (db.users[p] = { name: String(b.name || "").trim().slice(0, 40) || "Listener", phone: p, premium: false, liked: [], pls: [], dl: [], hist: {}, created: Date.now() });
  save(); return { token: sign({ sub: p, exp: Date.now() + 30 * 864e5 }), user: { name: u.name } };
});
R("GET", "/api/me/data", ({ u }) => ({ user: { name: u.name }, liked: u.liked, pls: u.pls, dl: u.dl, hist: u.hist, premium: u.premium }), true);
R("PUT", "/api/me/data", async ({ req, u }) => {
  const b = await body(req), K = new Set(tracks().map(t => t.id));
  const ids = (a, max, m) => Array.isArray(a) && a.length <= max && a.every(x => K.has(x)) ? [...new Set(a)] : bad(m);
  if ("liked" in b) u.liked = ids(b.liked, 5000, "Invalid liked list");
  if ("dl" in b) u.dl = ids(b.dl, 5000, "Invalid downloads");
  if ("pls" in b) { if (!Array.isArray(b.pls) || b.pls.length > 50) bad("Invalid playlists"); u.pls = b.pls.map(x => ({ id: String(x.id).slice(0, 40), name: String(x.name).slice(0, 60), ids: ids(x.ids, 500, "Invalid playlist tracks") })); }
  if ("hist" in b) { if (!b.hist || typeof b.hist !== "object" || Array.isArray(b.hist)) bad("Invalid history"); u.hist = {}; for (const [k, v] of Object.entries(b.hist)) if (K.has(k) && Number.isFinite(v)) u.hist[k] = Math.max(0, Math.min(1e6, Math.floor(v))); }
  saveSoon(); return { ok: true };
}, true);
R("POST", "/api/billing/demo", async ({ req, u }) => { // DEMO ONLY: replace with Razorpay/Stripe checkout + webhook that sets u.premium
  if (process.env.DEMO_BILLING === "0") bad("Billing is not enabled", 501);
  u.premium = !!(await body(req)).premium; save(); return { premium: u.premium };
}, true);

/* ---------- media (HTTP Range so seeking works) and static files ---------- */
const AUDIO = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac" };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };
function media(req, res, name) {
  const p = path.join(MEDIA, path.basename(name)), type = AUDIO[path.extname(p).toLowerCase()];
  fs.stat(p, (e, st) => {
    if (e || !st.isFile() || !type) { res.writeHead(e || !st.isFile() ? 404 : 415); return res.end(); }
    let s = 0, en = st.size - 1, code = 200; const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (m) {
      if (m[1] === "" && m[2] !== "") s = Math.max(0, st.size - +m[2]); else { if (m[1] !== "") s = +m[1]; if (m[2] !== "") en = Math.min(+m[2], st.size - 1); }
      if (s > en || s >= st.size) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
      code = 206;
    }
    res.writeHead(code, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": en - s + 1, "Cache-Control": "public, max-age=3600", ...(code === 206 && { "Content-Range": `bytes ${s}-${en}/${st.size}` }) });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(p, { start: s, end: en }).pipe(res);
  });
}
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p.startsWith("/media/")) return media(req, res, p.slice(7));
  if (p === "/") p = "/index.html";
  const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    if (p === "/index.html") d = d.toString().replace("<!--BOOT-->", `<script>window.__BOOT=${JSON.stringify({ tracks: tracks() }).replace(/</g, "\\u003c")}</script>`);
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": p === "/index.html" ? "no-cache" : "public, max-age=3600" });
    res.end(d);
  });
}

http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const o = req.headers.origin; // the Android app loads its UI from appassets.androidplatform.net
  if (o && ORIGINS.includes(o)) {
    res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization"); res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      for (const [m, re, h, auth] of routes) {
        const x = m === req.method && re.exec(url.pathname); if (!x) continue;
        const u = me(req); if (auth && !u) bad("Sign in required", 401);
        return send(res, 200, await h({ req, res, m: x.map(decodeURIComponent), u, url }));
      }
      bad("Not found", 404);
    }
    if (req.method !== "GET" && req.method !== "HEAD") bad("Method not allowed", 405);
    serveStatic(req, res, url);
  } catch (e) {
    const c = typeof e.code === "number" ? e.code : 500; if (c === 500) console.error(e);
    if (!res.headersSent) send(res, c, { error: c === 500 ? "Server error" : e.message });
  }
}).listen(PORT, () => console.log(`Dhun running at http://localhost:${PORT} (${DEV ? "dev" : "production"} mode)`));
