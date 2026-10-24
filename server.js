// Runs index.html (the whole bot) 24/7 on a server, e.g. Railway.
// The page logic runs unchanged inside jsdom; your browser only shows a live copy of it and
// forwards clicks and inputs. Closing the browser does not stop the bot.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { webcrypto } = require("crypto");
const { JSDOM, VirtualConsole } = require("jsdom");

const PORT = Number(process.env.PORT || 8080);
const PASSWORD = (process.env.UI_PASSWORD || "").trim();
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "data"));
const STORE = path.join(DATA_DIR, "storage.json");
const PAGE = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function log(...a) { console.log(new Date().toISOString().replace("T", " ").slice(0, 19), ...a); }

// ---------------- persistent localStorage ----------------
fs.mkdirSync(DATA_DIR, { recursive: true });
let saved = {};
try { saved = JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { saved = {}; }
// keys from Railway variables win over anything typed earlier
if (process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET) {
  const env = (process.env.BYBIT_ENV || "mainnet").trim().toLowerCase() === "testnet" ? "testnet" : "mainnet";
  saved["bx.keys"] = JSON.stringify({ key: process.env.BYBIT_API_KEY.trim(), secret: process.env.BYBIT_API_SECRET.trim(), env });
  saved["bx.env"] = JSON.stringify(env);
}

let dom;
// activity of the bot itself: when it last talked to Bybit (works with no browser open)
const ACT = { last: 0, count: 0, started: Date.now() };
function running() { try { return JSON.parse(dom.window.localStorage.getItem("bx.running") || "false") === true; } catch { return false; } }
function dumpStorage() {
  if (!dom) return;
  const ls = dom.window.localStorage, out = {};
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); out[k] = ls.getItem(k); }
  const text = JSON.stringify(out);
  if (text === dumpStorage.last) return;
  dumpStorage.last = text;
  const tmp = STORE + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, STORE);
}

// ---------------- run the page ----------------
const vc = new VirtualConsole();
vc.on("log", (...a) => log("[page]", ...a));
vc.on("warn", (...a) => log("[page warn]", ...a));
vc.on("error", (...a) => log("[page error]", ...a));
vc.on("jsdomError", (e) => log("[page error]", e && (e.stack || e.message || e)));

dom = new JSDOM(PAGE, {
  url: "https://proboystrategy.local/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    for (const [k, v] of Object.entries(saved)) { try { window.localStorage.setItem(k, v); } catch {} }
    // TEST_BYBIT_URL: send the page's Bybit requests to a test server (used for automated checks only)
    const testUrl = (process.env.TEST_BYBIT_URL || "").trim();
    window.fetch = (input, init) => {
      if (testUrl && typeof input === "string") input = input.replace(/^https:\/\/api(-testnet)?\.bybit\.com/, testUrl);
      if (typeof input === "string" && /bybit\.com|127\.0\.0\.1:9333/.test(input)) { ACT.last = Date.now(); ACT.count++; }
      return fetch(input, init);
    };
    window.Headers = Headers; window.Request = Request; window.Response = Response;
    window.AbortController = AbortController;
    Object.defineProperty(window, "crypto", { value: webcrypto, configurable: true });
    window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    // the user already confirmed by clicking in the remote page
    window.confirm = () => true;
    window.alert = (m) => log("[alert]", m);
    window.prompt = () => null;
    window.scrollTo = () => {};
    window.HTMLElement.prototype.scrollIntoView = function () {};
  },
});
setInterval(dumpStorage, 5000);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { try { dumpStorage(); } catch {} process.exit(0); });
process.on("unhandledRejection", (e) => log("unhandled:", e && (e.message || e)));
process.on("uncaughtException", (e) => log("uncaught:", e && (e.stack || e.message || e)));
log(`page started · storage ${STORE} · keys from env: ${process.env.BYBIT_API_KEY ? "yes" : "no"}`);

// ---------------- is Bybit reachable from this server? ----------------
const NET = { text: "Bybit: перевіряю…", ok: null };
async function checkBybit() {
  const env = (() => { try { return JSON.parse(dom.window.localStorage.getItem("bx.env") || '"mainnet"'); } catch { return "mainnet"; } })();
  const host = (process.env.TEST_BYBIT_URL || "").trim() || (env === "testnet" ? "https://api-testnet.bybit.com" : "https://api.bybit.com");
  try {
    const r = await fetch(host + "/v5/market/time", { signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.retCode === 0) { NET.ok = true; NET.text = `Bybit ${env}: зв'язок є`; }
    else if (r.status === 403 || r.status === 451) {
      NET.ok = false;
      NET.text = `Bybit блокує регіон цього сервера (HTTP ${r.status}). Railway → сервіс → Settings → Region → Europe West або Southeast Asia, не US.`;
    } else { NET.ok = false; NET.text = `Bybit відповів HTTP ${r.status}`; }
  } catch (e) { NET.ok = false; NET.text = "Немає зв'язку з Bybit: " + (e.message || e); }
  log(NET.text);
}
setTimeout(checkBybit, 1000);
setInterval(() => log(`heartbeat: bot ${running() ? "RUNNING" : "stopped"} · Bybit requests ${ACT.count} · last ${ACT.last ? Math.round((Date.now() - ACT.last) / 1000) + "s ago" : "never"}`), 10 * 60000);
setInterval(checkBybit, 10 * 60000);

// ---------------- snapshot of the live page ----------------
const doc = () => dom.window.document;
function snapshot() {
  const body = doc().body.cloneNode(true);
  const live = doc().body.querySelectorAll("input, select, textarea");
  const copy = body.querySelectorAll("input, select, textarea");
  live.forEach((el, i) => {
    const c = copy[i];
    if (!c) return;
    if (el.tagName === "SELECT") {
      c.querySelectorAll("option").forEach(o => { o.removeAttribute("selected"); if (o.value === el.value) o.setAttribute("selected", ""); });
    } else if (el.type === "checkbox" || el.type === "radio") {
      if (el.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked");
    } else if (el.id === "k-secret") {
      c.setAttribute("value", ""); // never send the secret to the browser
      c.setAttribute("placeholder", el.value ? "задано на сервері" : "");
    } else if (el.tagName === "TEXTAREA") {
      c.textContent = el.value;
    } else {
      c.setAttribute("value", el.value);
    }
    if (el.disabled) c.setAttribute("disabled", ""); else c.removeAttribute("disabled");
  });
  body.querySelectorAll("script").forEach(s => s.remove());
  return body.innerHTML;
}

function find(p) {
  if (p.id) { const el = doc().getElementById(p.id); if (el) return el; }
  let el = doc().body;
  for (const i of p.path || []) { el = el && el.children[i]; }
  if (!el) return null;
  // the page may have re-rendered since the click: make sure it is the same element
  if (p.tag && el.tagName !== p.tag) return null;
  if (p.text != null && (el.textContent || "").trim().slice(0, 60) !== p.text) return null;
  return el;
}

async function act(p) {
  const el = find(p);
  if (!el) return { ok: false, error: "Сторінка оновилась — натисніть ще раз" };
  const w = dom.window;
  if (p.type === "click") {
    el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  } else if (p.type === "change" || p.type === "input") {
    if (el.id === "k-secret" && !p.value) return { ok: true };
    if (el.type === "checkbox" || el.type === "radio") el.checked = !!p.checked; else el.value = p.value;
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
    el.dispatchEvent(new w.Event("change", { bubbles: true }));
  }
  await new Promise(r => setTimeout(r, 400));
  return { ok: true };
}

// ---------------- remote page ----------------
const VIEWER = `
<div id="__remote" style="position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:6px 12px;font:12px system-ui;background:#161a1e;color:#848e9c;border-top:1px solid #2b3139;display:flex;gap:10px;justify-content:space-between">
  <span>Сервер · бот працює 24/7 навіть із закритою сторінкою · <b id="__net"></b></span><span id="__rs">…</span>
</div>
<script>
(function () {
  const RO = ${PASSWORD ? "false" : "true"};
  const st = (t) => { document.getElementById("__rs").textContent = t; };
  function pathOf(el) {
    const p = [];
    while (el && el !== document.body) { p.unshift([...el.parentElement.children].indexOf(el)); el = el.parentElement; }
    return p;
  }
  function target(el) {
    // the clickable element: button, link, tab, summary or anything with data-* / onclick
    return el.closest("button, a, summary, [data-tab], [data-k], label, input, select, [onclick]") || el;
  }
  function desc(el) {
    return { path: pathOf(el), id: el.id || "", tag: el.tagName, text: (el.textContent || "").trim().slice(0, 60) };
  }
  async function send(body) {
    if (RO) { st("Лише перегляд: задайте UI_PASSWORD у Railway, щоб керувати"); return; }
    st("надсилаю…");
    try {
      const r = await fetch("/__act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(x => x.json());
      if (!r.ok) st(r.error || "помилка");
      await refresh(true);
    } catch (e) { st("немає зв'язку з сервером"); }
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest("#__remote")) return;
    const el = target(e.target);
    if (["INPUT", "SELECT", "TEXTAREA", "LABEL"].includes(el.tagName)) return;
    e.preventDefault(); e.stopPropagation();
    send(Object.assign(desc(el), { type: "click" }));
  }, true);
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) return;
    send(Object.assign(desc(el), { type: "change", value: el.value, checked: el.checked, text: null }));
  }, true);
  async function refresh(force) {
    const a = document.activeElement;
    if (!force && a && ["INPUT", "SELECT", "TEXTAREA"].includes(a.tagName) && a !== document.body) return; // do not disturb typing
    try {
      const r = await fetch("/__snapshot").then(x => x.json());
      const n = document.getElementById("__net");
      const a = r.act || {};
      const run = a.running ? "бот працює на сервері" + (a.ago >= 0 ? " · останній запит до Bybit " + a.ago + " с тому" : "") : "бот зупинений (натисніть «Запустити бота»)";
      if (n) { n.textContent = run + " · " + r.net.text; n.style.color = r.net.ok === false ? "#f6465d" : r.net.ok ? "#0ecb81" : ""; }
      const keep = document.getElementById("__remote");
      const y = window.scrollY;
      const open = [...document.querySelectorAll("details[open]")].map(pathOf).map(String);
      document.body.innerHTML = r.body;
      document.body.appendChild(keep);
      document.querySelectorAll("details").forEach(d => { if (open.includes(String(pathOf(d)))) d.open = true; });
      window.scrollTo(0, y);
      st((RO ? "лише перегляд · " : "") + "оновлено " + new Date().toLocaleTimeString());
    } catch (e) { st("немає зв'язку з сервером"); }
  }
  refresh(true);
  setInterval(refresh, 3000);
})();
</script>`;

function remotePage() {
  const head = PAGE.slice(0, PAGE.indexOf("<body")).replace(/<script[\s\S]*?<\/script>/gi, "");
  const bodyTag = (PAGE.match(/<body[^>]*>/i) || ["<body>"])[0];
  return head + bodyTag + snapshot() + VIEWER + "</body></html>";
}

function authorised(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const [, pass] = Buffer.from(h.slice(6), "base64").toString().split(/:(.*)/s);
  return pass === PASSWORD;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body, type) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" }); res.end(body); };
  if (url.pathname === "/healthz") return send(200, "ok", "text/plain");
  if (url.pathname === "/__net") return send(200, JSON.stringify(Object.assign({}, NET, { running: running(), lastBybitSecAgo: ACT.last ? Math.round((Date.now() - ACT.last) / 1000) : -1, requests: ACT.count })), "application/json; charset=utf-8");
  if (!authorised(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="proboystrategy"' });
    return res.end("Потрібен пароль (UI_PASSWORD)");
  }
  try {
    if (url.pathname === "/__snapshot") return send(200, JSON.stringify({ body: snapshot(), net: NET, act: { ago: ACT.last ? Math.round((Date.now() - ACT.last) / 1000) : -1, count: ACT.count, running: running(), upMin: Math.round((Date.now() - ACT.started) / 60000) } }), "application/json; charset=utf-8");
    if (url.pathname === "/__act" && req.method === "POST") {
      if (!PASSWORD) return send(200, JSON.stringify({ ok: false, error: "Лише перегляд: задайте UI_PASSWORD" }), "application/json");
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 1e5) break; }
      const out = await act(JSON.parse(raw || "{}"));
      dumpStorage();
      return send(200, JSON.stringify(out), "application/json; charset=utf-8");
    }
    return send(200, remotePage(), "text/html; charset=utf-8");
  } catch (e) {
    return send(500, JSON.stringify({ ok: false, error: String(e && e.message || e) }), "application/json");
  }
}).listen(PORT, "0.0.0.0", () => log(`http :${PORT}${PASSWORD ? " · password on" : " · NO UI_PASSWORD: page is read-only"}`));
