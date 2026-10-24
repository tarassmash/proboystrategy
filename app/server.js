// Proboy Autopilot: the whole bot (engine.html) runs 24/7 on the server.
// The page has two buttons: Start/Stop (autopilot) and Scalping (take +0.5%, stop -1%).
"use strict";
// times in the bot log in your time zone (Railway runs in UTC); change with the TZ variable
process.env.TZ = process.env.TZ || "Europe/Madrid";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { webcrypto } = require("crypto");
const { JSDOM, VirtualConsole } = require("jsdom");

const PORT = Number(process.env.PORT || 8080);
const PASSWORD = (process.env.UI_PASSWORD || "").trim();
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "data"));
const STORE = path.join(DATA_DIR, "storage.json");
const ENGINE = fs.readFileSync(path.join(__dirname, "engine.html"), "utf8");
const TEST_URL = (process.env.TEST_BYBIT_URL || "").trim(); // automated checks only

const log = (...a) => console.log(new Date().toISOString().replace("T", " ").slice(0, 19), ...a);

// ---------------- saved state (bot settings, setups, journal) ----------------
fs.mkdirSync(DATA_DIR, { recursive: true });
let saved = {};
try { saved = JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { saved = {}; }
const ENV = (process.env.BYBIT_ENV || "mainnet").trim().toLowerCase() === "testnet" ? "testnet" : "mainnet";
const HAS_KEYS = !!(process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET);
if (HAS_KEYS) {
  saved["bx.keys"] = JSON.stringify({ key: process.env.BYBIT_API_KEY.trim(), secret: process.env.BYBIT_API_SECRET.trim(), env: ENV });
  saved["bx.env"] = JSON.stringify(ENV);
}
// optional trade size from variables (only on the first start; later the saved settings win)
if (saved["bx.settings"] === undefined) {
  const st = {};
  if (process.env.MARGIN_USDT) st.margin = Number(process.env.MARGIN_USDT);
  if (process.env.LEVERAGE) st.leverage = Number(process.env.LEVERAGE);
  if (Object.keys(st).length) saved["bx.settings"] = JSON.stringify(st);
}
// AUTOSTART=1: a fresh server starts trading by itself; afterwards the Stop button wins
if ((process.env.AUTOSTART || "").trim() === "1" && saved["bx.running"] === undefined && HAS_KEYS) {
  saved["bx.running"] = "true";
  const st = JSON.parse(saved["bx.settings"] || "{}"); st.autopilot = true;
  saved["bx.settings"] = JSON.stringify(st);
}

const ACT = { last: 0, count: 0, started: Date.now() };
let dom;
function dumpStorage() {
  if (!dom) return;
  const ls = dom.window.localStorage, out = {};
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); out[k] = ls.getItem(k); }
  const text = JSON.stringify(out);
  if (text === dumpStorage.last) return;
  dumpStorage.last = text;
  fs.writeFileSync(STORE + ".tmp", text);
  fs.renameSync(STORE + ".tmp", STORE);
}

// ---------------- the bot engine ----------------
const vc = new VirtualConsole();
vc.on("log", (...a) => log("[bot]", ...a));
vc.on("error", (...a) => log("[bot error]", ...a));
vc.on("jsdomError", (e) => log("[bot error]", e && (e.stack || e.message || e)));
dom = new JSDOM(ENGINE, {
  url: "https://proboy-autopilot.local/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    for (const [k, v] of Object.entries(saved)) { try { window.localStorage.setItem(k, v); } catch {} }
    window.fetch = (input, init) => {
      if (typeof input === "string") {
        if (TEST_URL) input = input.replace(/^https:\/\/api(-testnet)?\.bybit\.com/, TEST_URL);
        if (/bybit\.com|^http:\/\/127\.0\.0\.1/.test(input)) { ACT.last = Date.now(); ACT.count++; }
      }
      return fetch(input, init);
    };
    Object.defineProperty(window, "crypto", { value: webcrypto, configurable: true });
    window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
    window.AbortController = AbortController;
    window.confirm = () => true;  // the owner pressed the button on this app's page
    window.alert = (m) => log("[alert]", m);
    window.scrollTo = () => {};
    window.HTMLElement.prototype.scrollIntoView = function () {};
  },
});
const W = dom.window, D = W.document;
setInterval(dumpStorage, 5000);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { try { dumpStorage(); } catch {} process.exit(0); });
process.on("unhandledRejection", (e) => log("unhandled:", e && (e.message || e)));
process.on("uncaughtException", (e) => log("uncaught:", e && (e.stack || e.message || e)));

const ev = (code) => { try { return W.eval(code); } catch (e) { return undefined; } };
const click = (id) => { const el = D.getElementById(id); if (el) el.dispatchEvent(new W.MouseEvent("click", { bubbles: true, cancelable: true })); };

// ---------------- account + reachability ----------------
const ACC = { equity: null, available: null, error: "", at: 0 };
const NET = { ok: null, text: "перевіряю зв'язок з Bybit…" };
async function refreshAccount() {
  if (!HAS_KEYS && !ev("$('k-key').value")) { ACC.error = "немає ключів Bybit (BYBIT_API_KEY / BYBIT_API_SECRET у Variables)"; return; }
  try {
    const r = await ev(`bx("/v5/account/wallet-balance", { query: { accountType: "UNIFIED" }, auth: true })`);
    const a = ((r && r.list) || [])[0] || {};
    Object.assign(ACC, { equity: Number(a.totalEquity || 0), available: Number(a.totalAvailableBalance || 0), error: "", at: Date.now() });
    NET.ok = true; NET.text = `Bybit ${ENV}: зв'язок є`;
  } catch (e) {
    const m = String(e && e.message || e);
    ACC.error = m;
    if (/403|блокує країну/.test(m)) { NET.ok = false; NET.text = "Bybit блокує регіон сервера: Railway → Settings → Region → Europe West або Southeast Asia"; }
    else if (/fetch|зв'язку|мереж/i.test(m)) { NET.ok = false; NET.text = "немає зв'язку з Bybit"; }
  }
}
setTimeout(refreshAccount, 1500);
setInterval(refreshAccount, 30000);
setInterval(() => log(`heartbeat: ${ev("RUN") ? "RUNNING" : "stopped"}${ev("CFG.scalp") ? " scalp" : ""} · Bybit requests ${ACT.count}`), 10 * 60000);

function state() {
  const s = JSON.parse(ev(`JSON.stringify({
    run: RUN, auto: !!CFG.autopilot, scalp: !!CFG.scalp, tp: CFG.tpPct, sl: CFG.slPct, margin: CFG.margin, lev: CFG.leverage,
    scanMin: CFG.scanMin, maxSetups: AP.slots || CFG.maxSetups, byBalance: CFG.maxMode !== "fixed", refreshMin: CFG.refreshMin, chase: CFG.chase !== "off", chaseAt: CFG.chaseAt, relax: AP.relax || 0, added: AP.added || 0,
    nextScan: RUN ? Math.max(0, Math.round((lastScan + CFG.scanMin * 60e3 - Date.now()) / 1000)) : null,
    setups: SETUPS.map(s => ({ symbol: s.symbol, state: s.state, kind: s.kind, now: !!s.now, buy: s.buy && s.buy.trigger, sell: s.sell && s.sell.trigger, entry: s.entry || null })),
    pos: POS.map(p => { const s = SETUPS.find(x => x.symbol === p.symbol) || {}; return ({ symbol: p.symbol, side: p.side, size: p.size, entry: p.avgPrice, mark: p.markPrice, pnl: Number(p.unrealisedPnl || 0), sl: p.stopLoss, tp: p.takeProfit, chaseN: s.chaseN || 0, maxGain: s.maxGain || 0, be: !!s.beDone }); }),
    trades: JOURNAL.filter(j => !j.noTrade).slice(-200).map(j => ({ pnl: Number(j.pnl || 0), at: j.closedAt })),
    err: document.getElementById("note-err") ? document.getElementById("note-err").textContent : ""
  })`) || "{}");
  const logs = [...D.querySelectorAll("#log > li")].slice(0, 15).map(li => [...li.children].map(c => c.textContent.trim()).join("  "));
  const day = Date.now() - 86400e3;
  const tr = s.trades || [];
  const today = tr.filter(t => t.at >= day);
  return Object.assign(s, {
    logs, acc: ACC, net: NET, env: ENV, keys: HAS_KEYS, password: !!PASSWORD,
    lastBybitSec: ACT.last ? Math.round((Date.now() - ACT.last) / 1000) : -1, upMin: Math.round((Date.now() - ACT.started) / 60000),
    stats: {
      all: tr.length, pnl: tr.reduce((a, t) => a + t.pnl, 0), win: tr.length ? Math.round(tr.filter(t => t.pnl > 0).length / tr.length * 100) : null,
      today: today.length, todayPnl: today.reduce((a, t) => a + t.pnl, 0),
    },
    trades: undefined,
  });
}

async function act(what) {
  if (what === "start") {
    if (ev("RUN") && ev("CFG.autopilot")) return "Вже працює";
    if (!ev("CFG.autopilot")) click("btn-auto"); else click("btn-start");
  } else if (what === "stop") {
    click("btn-stop");
  } else if (what === "scalp") {
    ev(`applyPreset(CFG.scalp ? "normal" : "scalp")`);
  } else return "Невідома дія";
  await new Promise(r => setTimeout(r, 2500));
  dumpStorage();
  const err = ev(`document.getElementById("note-err").textContent`) || "";
  return err && what === "start" && !ev("RUN") ? "Не запустився: " + err : "OK";
}

// ---------------- the app page ----------------
const PAGE = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proboy Autopilot</title>
<style>
:root{--bg:#0b0e11;--panel:#161a1e;--line:#2b3139;--ink:#eaecef;--mute:#848e9c;--up:#0ecb81;--down:#f6465d;--gold:#f7a600}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:16px}h1{font-size:20px;margin:4px 0 2px}.mute{color:var(--mute)}.up{color:var(--up)}.down{color:var(--down)}.gold{color:var(--gold)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;margin-top:14px}
.big{width:100%;min-height:72px;border-radius:16px;border:0;font-size:22px;font-weight:700;cursor:pointer}
.go{background:var(--up);color:#06281b}.stop{background:var(--down);color:#fff}.sc{background:transparent;border:2px solid var(--gold);color:var(--gold);min-height:60px;font-size:18px}.sc.on{background:var(--gold);color:#111}
.big:disabled{opacity:.5;cursor:default}.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.k b{display:block;font:600 18px ui-monospace,monospace}.k span{font-size:12px;color:var(--mute)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--mute);margin-right:6px}.dot.on{background:var(--up);box-shadow:0 0 10px var(--up)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--mute);font-weight:500}
.scroll{overflow-x:auto}.log div{font:12px ui-monospace,monospace;padding:4px 0;border-bottom:1px solid var(--line);color:var(--mute)}
.note{border-radius:12px;padding:10px 12px;margin-top:12px;font-size:13px}.warn{background:rgba(246,70,93,.1);border:1px solid rgba(246,70,93,.4)}
</style></head><body><div class="wrap">
<h1>Proboy Autopilot</h1><div class="mute" id="sub">Бот працює на сервері 24/7 — сторінку можна закрити</div>
<div class="card"><div style="font-size:18px;font-weight:600"><span class="dot" id="dot"></span><span id="status">…</span></div>
<div class="mute" id="status2" style="margin-top:4px"></div>
<div style="margin-top:14px"><button class="big go" id="main">▶ Запустити</button></div>
<div style="margin-top:10px"><button class="big sc" id="scalp">⚡ Скальпінг</button></div>
<div id="chaseLine" style="font-size:13px;margin-top:10px"></div>
<div class="mute" id="scalpHint" style="font-size:12px;margin-top:6px">Скальпінг: короткі угоди, тейк +0.5%, стоп −1% від входу, скан щохвилини.</div>
<div id="warn"></div></div>
<div class="card row">
<div class="k"><span>Капітал, USDT</span><b id="eq">—</b></div><div class="k"><span>Вільно</span><b id="av">—</b></div>
<div class="k"><span>Сьогодні угод / PnL</span><b id="td">—</b></div><div class="k"><span>Усього угод · win</span><b id="all">—</b></div></div>
<div class="card"><b>Позиції</b><div class="scroll"><table><thead><tr><th>Монета</th><th>Бік</th><th>Вхід</th><th>Ціна</th><th>PnL</th><th>Стоп / Тейк</th><th>Імпульс</th></tr></thead><tbody id="pos"></tbody></table></div></div>
<div class="card"><b>Заявки бота на біржі</b><div class="scroll"><table><thead><tr><th>Монета</th><th>Стан</th><th>Buy Stop</th><th>Sell Stop</th></tr></thead><tbody id="set"></tbody></table></div></div>
<div class="card"><b>Що робить бот</b><div class="log" id="log"></div></div>
<div class="mute" style="font-size:12px;margin:14px 0" id="foot"></div>
</div><script>
const $=(i)=>document.getElementById(i);const esc=(s)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const f=(v,d=2)=>v==null||isNaN(v)?"—":Number(v).toFixed(d);let S=null,busy=false;
async function load(){try{S=await fetch("/api/state").then(r=>r.json());paint()}catch(e){$("status").textContent="немає зв'язку з сервером"}}
function paint(){const on=S.run&&S.auto;$("dot").className="dot"+(on?" on":"");
$("status").textContent=on?(S.scalp?"Працює · скальпінг":"Працює · автопілот"):(S.run?"Працює (без автопілота)":"Зупинено");
$("status2").textContent=on?("Наступний скан через "+S.nextScan+" с · заявок/позицій "+S.setups.length+" з "+S.maxSetups+(S.byBalance?" (максимум за балансом)":"")+" · оновлення заявок кожні "+S.refreshMin+" хв · маржа "+S.margin+" USDT × x"+S.lev+(S.relax?" · фільтри послаблено "+S.relax+"/3":"")):"Натисніть «Запустити» — далі бот торгує сам, доки ви не зупините";
const m=$("main");m.textContent=on?"■ Зупинити":"▶ Запустити";m.className="big "+(on?"stop":"go");m.disabled=busy;
const sc=$("scalp");sc.className="big sc"+(S.scalp?" on":"");sc.textContent=S.scalp?"⚡ Скальпінг увімкнено · +"+S.tp+"% / −"+S.sl+"%":"⚡ Скальпінг";sc.disabled=busy;
const w=[];if(!S.keys)w.push("Немає ключів Bybit: Railway → Variables → BYBIT_API_KEY, BYBIT_API_SECRET");if(S.net.ok===false)w.push(S.net.text);if(S.acc.error&&S.net.ok!==false)w.push("Bybit: "+S.acc.error);if(S.err)w.push(S.err);
$("chaseLine").innerHTML=S.chase?'<span class="up">🚀 Трейлінг стопа і тейку увімкнено</span> <span class="mute">— після '+Math.round(S.chaseAt*100)+"% шляху до тейку стоп іде за ціною, а тейк відсувається далі в бік руху, щоб забрати весь імпульс</span>":'<span class="mute">Трейлінг стопа і тейку вимкнено</span>';
$("warn").innerHTML=w.map(x=>'<div class="note warn">'+esc(x)+"</div>").join("");
$("eq").textContent=f(S.acc.equity);$("av").textContent=f(S.acc.available);
$("td").innerHTML=S.stats.today+' / <span class="'+(S.stats.todayPnl>=0?"up":"down")+'">'+(S.stats.todayPnl>=0?"+":"")+f(S.stats.todayPnl,3)+"</span>";
$("all").textContent=S.stats.all+(S.stats.win!=null?" · "+S.stats.win+"%":"");
$("pos").innerHTML=S.pos.length?S.pos.map(p=>"<tr><td><b>"+esc(p.symbol)+'</b></td><td class="'+(p.side==="Buy"?"up":"down")+'">'+(p.side==="Buy"?"LONG":"SHORT")+"</td><td>"+esc(p.entry)+"</td><td>"+esc(p.mark)+'</td><td class="'+(p.pnl>=0?"up":"down")+'">'+(p.pnl>=0?"+":"")+f(p.pnl,4)+"</td><td>"+esc(p.sl||"—")+" / "+esc(p.tp||"—")+"</td><td>"+(p.chaseN?'<span class="up">🚀 веде: стоп і тейк підтягнуто '+p.chaseN+"×, макс +"+f(p.maxGain,2)+"%</span>":(S.chase?'<span class="mute">чекає '+Math.round(S.chaseAt*100)+"% шляху до тейку</span>":'<span class="mute">вимкнено</span>'))+"</td></tr>").join(""):'<tr><td colspan="7" class="mute">Позицій немає</td></tr>';
$("set").innerHTML=S.setups.length?S.setups.map(s=>"<tr><td><b>"+esc(s.symbol)+"</b></td><td>"+(s.state==="armed"?"чекає пробою":s.state==="long"?'<span class="up">LONG</span>':'<span class="down">SHORT</span>')+"</td><td>"+esc(s.buy||"—")+"</td><td>"+esc(s.sell||"—")+"</td></tr>").join(""):'<tr><td colspan="4" class="mute">Заявок немає</td></tr>';
$("log").innerHTML=S.logs.length?S.logs.map(l=>"<div>"+esc(l)+"</div>").join(""):'<div>Поки тихо</div>';
$("foot").textContent=S.env+" · "+S.net.text+" · останній запит до Bybit "+(S.lastBybitSec>=0?S.lastBybitSec+" с тому":"—")+" · сервер працює "+S.upMin+" хв";}
async function act(what,q){if(q&&!confirm(q))return;busy=true;paint();try{const r=await fetch("/api/"+what,{method:"POST"}).then(r=>r.json());if(r.text&&r.text!=="OK")alert(r.text)}catch(e){alert("Немає зв'язку з сервером")}busy=false;await load()}
$("main").onclick=()=>{const on=S&&S.run&&S.auto;on?act("stop","Зупинити бота? Заявки бота, що чекають пробою, буде знято. Відкриті позиції лишаться зі своїм стопом і тейком."):act("start",S&&S.env==="mainnet"?"Запустити торгівлю на реальному рахунку?":"")};
$("scalp").onclick=()=>act("scalp",S&&!S.scalp?"Увімкнути скальпінг? Тейк +0.5%, стоп −1% від входу. Діє на нові заявки.":"");
load();setInterval(load,3000);
</script></body></html>`;

function authorised(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const pass = Buffer.from(h.slice(6), "base64").toString().split(/:(.*)/s)[1];
  return pass === PASSWORD;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
  if (url.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (!authorised(req)) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Proboy Autopilot"' }); return res.end("Потрібен пароль (UI_PASSWORD)"); }
  try {
    if (url.pathname === "/api/state") return json(200, state());
    if (req.method === "POST" && /^\/api\/(start|stop|scalp)$/.test(url.pathname)) {
      if (!PASSWORD) return json(200, { text: "Задайте UI_PASSWORD у Railway → Variables, щоб керувати ботом" });
      return json(200, { text: await act(url.pathname.split("/").pop()) });
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(PAGE);
  } catch (e) { return json(500, { text: String(e && e.message || e) }); }
}).listen(PORT, "0.0.0.0", () => log(`Proboy Autopilot :${PORT} · ${ENV} · keys ${HAS_KEYS ? "yes" : "no"} · ${PASSWORD ? "password on" : "NO UI_PASSWORD (buttons locked)"} · storage ${STORE}`));
