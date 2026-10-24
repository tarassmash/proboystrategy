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
    W.__eq = ACC.equity;
    // equity curve for the progress chart: one point every 10 minutes, ~3 weeks kept
    try {
      const eq = JSON.parse(W.localStorage.getItem("bx.eq") || "[]");
      if (ACC.equity > 0 && (!eq.length || Date.now() - eq[eq.length - 1][0] >= 10 * 60000)) {
        eq.push([Date.now(), +ACC.equity.toFixed(4)]);
        W.localStorage.setItem("bx.eq", JSON.stringify(eq.slice(-3000)));
      }
    } catch {}
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

// ---------------- AI autopilot (fal.ai any-llm) ----------------
// Every AI_EVERY_MIN minutes the model gets the market, the account, open positions and recent results and
// returns a JSON decision: trading style, settings, positions to close. The bot applies it only inside hard limits.
const FAL_KEY = (process.env.FAL_KEY || process.env.FAL_API_KEY || "").trim();
const FAL_URL = (process.env.FAL_URL || "https://fal.run/fal-ai/any-llm").trim();
const FAL_MODEL = (process.env.FAL_MODEL || "google/gemini-2.5-flash").trim();
const AI_EVERY = Math.max(5, Number(process.env.AI_EVERY_MIN || 15));
const lsGet = (k, d) => { try { const v = W.localStorage.getItem("bx." + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { W.localStorage.setItem("bx." + k, JSON.stringify(v)); } catch {} };
const AI = Object.assign({ on: false, last: 0, busy: false, history: [], error: "", maxLev: null, maxMargin: null }, lsGet("ai", {}));
AI.busy = false;
const saveAI = () => lsSet("ai", { on: AI.on, last: AI.last, history: AI.history.slice(-300), error: AI.error, maxLev: AI.maxLev, maxMargin: AI.maxMargin });
// progress data for the chart: equity curve (downsampled), every AI decision with the result of its period
function progress() {
  let eq = []; try { eq = JSON.parse(W.localStorage.getItem("bx.eq") || "[]"); } catch {}
  const step = Math.max(1, Math.ceil(eq.length / 400));
  const pts = eq.filter((_, i) => i % step === 0 || i === eq.length - 1);
  const dec = AI.history.slice(-200).map(h => ({ at: h.at, mode: h.mode, pnl: h.periodPnl ?? null, trades: h.periodTrades ?? null, wins: h.periodWins ?? null, open: !h.closed }));
  const done = dec.filter(x => x.pnl != null);
  const last10 = done.slice(-10);
  const prev10 = done.slice(-20, -10);
  const avg = (a) => a.length ? a.reduce((x, y) => x + y.pnl, 0) / a.length : null;
  return { eq: pts, dec, quality: last10.length ? Math.round(last10.filter(x => x.pnl > 0).length / last10.length * 100) : null,
    avgLast: avg(last10), avgPrev: avg(prev10), periods: done.length, totalPnl: +done.reduce((a, x) => a + x.pnl, 0).toFixed(4) };
}
const LIMITS = {                       // the AI can never go outside these
  tpPct: [0.2, 5], slPct: [0.3, 5], tpR: [0.5, 10], chaseAt: [0.3, 0.95], chaseGap: [0.1, 1], chaseStep: [0.1, 3],
  squeeze: [10, 80], maxEr: [0.2, 0.8], minWidth: [0.2, 5], maxWidth: [0.5, 15], scanMin: [1, 30], refreshMin: [1, 30],
  beR: [0, 5], expiryH: [0.5, 24], cooldownMin: [5, 600],
  maxSetups: [1, 30], rocketScore: [20, 95], rocketTpR: [1, 20], tf: [1, 60], lookback: [12, 120], coins: [20, 300],
  minTurnover: [1, 1000], trailR: [0, 10], nowLadder: [0, 10],
};
const INT_KEYS = new Set(["scanMin", "refreshMin", "cooldownMin", "maxSetups", "rocketScore", "tf", "lookback", "coins", "nowLadder"]);
const TF_OK = [1, 3, 5, 15, 30, 60];
const engineLog = (t, cls) => { try { W.eval(`log(${JSON.stringify(t)}, ${JSON.stringify(cls || "gold-t")})`); } catch {} };

async function marketContext() {
  const out = {};
  try {
    const t = await ev(`bx("/v5/market/tickers", { query: { category: "linear", symbol: "BTCUSDT" } })`);
    const b = (t.list || [])[0] || {};
    out.btc = { price: Number(b.lastPrice), change24hPct: +(Number(b.price24hPcnt) * 100).toFixed(2), fundingRate: Number(b.fundingRate) };
    const k = await ev(`bx("/v5/market/kline", { query: { category: "linear", symbol: "BTCUSDT", interval: "60", limit: "24" } })`);
    const rows = (k.list || []).map(r => ({ h: +r[2], l: +r[3], c: +r[4] })).reverse();
    if (rows.length) {
      const c = rows.map(r => r.c);
      out.btc.change4hPct = +((c[c.length - 1] / c[Math.max(0, c.length - 5)] - 1) * 100).toFixed(2);
      out.btc.range24hPct = +((Math.max(...rows.map(r => r.h)) / Math.min(...rows.map(r => r.l)) - 1) * 100).toFixed(2);
      out.btc.avgHourlyMovePct = +(rows.reduce((a, r) => a + (r.h - r.l) / r.c, 0) / rows.length * 100).toFixed(2);
    }
  } catch (e) { out.btcError = String(e && e.message || e); }
  try {
    const all = ((await ev(`bx("/v5/market/tickers", { query: { category: "linear" } })`)).list || [])
      .filter(t => /USDT$/.test(t.symbol) && Number(t.turnover24h) > 5e6)
      .map(t => ({ symbol: t.symbol, ch24: +(Number(t.price24hPcnt) * 100).toFixed(2), turnoverM: Math.round(Number(t.turnover24h) / 1e6), funding: Number(t.fundingRate) }));
    const by = (f) => all.slice().sort(f);
    out.market = {
      coins: all.length,
      share_up_pct: all.length ? Math.round(all.filter(t => t.ch24 > 0).length / all.length * 100) : null,
      top_volume: by((a, b) => b.turnoverM - a.turnoverM).slice(0, 12),
      top_gainers: by((a, b) => b.ch24 - a.ch24).slice(0, 6),
      top_losers: by((a, b) => a.ch24 - b.ch24).slice(0, 6),
    };
  } catch (e) { out.marketError = String(e && e.message || e); }
  return out;
}

function botContext() {
  return JSON.parse(ev(`JSON.stringify({
    settings: { scalp: !!CFG.scalp, margin: CFG.margin, leverage: CFG.leverage, slMode: CFG.slMode, slPct: CFG.slPct, tpPct: CFG.tpPct, tpR: CFG.tpR,
      chase: CFG.chase, chaseAt: CFG.chaseAt, chaseGap: CFG.chaseGap, chaseStep: CFG.chaseStep, beR: CFG.beR,
      tf: CFG.tf, squeeze: CFG.squeeze, maxEr: CFG.maxEr, minWidth: CFG.minWidth, maxWidth: CFG.maxWidth,
      scanMin: CFG.scanMin, refreshMin: CFG.refreshMin, expiryH: CFG.expiryH, cooldownMin: CFG.cooldownMin, aiPause: !!CFG.aiPause },
    slots: AP.slots || CFG.maxSetups, filtersRelaxedStep: AP.relax || 0,
    positions: POS.map(p => { const s = SETUPS.find(x => x.symbol === p.symbol) || {}; const e = Number(p.avgPrice), m = Number(p.markPrice);
      return { symbol: p.symbol, side: p.side, entry: e, mark: m, movePct: +(((m - e) / e) * 100 * (p.side === "Buy" ? 1 : -1)).toFixed(2),
        pnlUsdt: +Number(p.unrealisedPnl || 0).toFixed(4), stop: Number(p.stopLoss) || null, take: Number(p.takeProfit) || null,
        minutesOpen: s.openedAt ? Math.round((Date.now() - s.openedAt) / 60000) : null, impulseSteps: s.chaseN || 0 }; }),
    waitingSetups: SETUPS.filter(s => s.state === "armed").map(s => ({ symbol: s.symbol, kind: s.kind, buyStop: s.buy && Number(s.buy.trigger), sellStop: s.sell && Number(s.sell.trigger), widthPct: +Number(s.width || 0).toFixed(2), minutesWaiting: Math.round((Date.now() - s.createdAt) / 60000) })).slice(0, 30),
    extra: { maxSetups: CFG.maxSetups, maxMode: CFG.maxMode, rocketScore: CFG.rocketScore, rocketTpR: CFG.rocketTpR, lookback: CFG.lookback, coins: CFG.coins, minTurnover: CFG.minTurnover, trailR: CFG.trailR, nowLadder: CFG.nowLadder },
    rockets: ROCKETS.slice(0, 6).map(r => ({ symbol: r.symbol, score: r.score, why: (r.reasons || []).slice(0, 3) })),
    lastTrades: JOURNAL.filter(j => !j.noTrade).slice(-25).map(j => ({ symbol: j.symbol, side: j.side, r: +Number(j.r || 0).toFixed(2), pnl: +Number(j.pnl || 0).toFixed(4), why: j.result || j.reason || "", kind: j.kind || "" })),
  })`) || "{}");
}

// ---------------- what makes money: results grouped by the settings each trade was opened with ----------------
const OPT_MIN = Math.max(2, Number(process.env.OPTIMIZE_MIN_TRADES || 5));
const OPT_KEYS = [
  ["style", "Стиль", (c) => c.style],
  ["tpPct", "Тейк, %", (c) => c.style === "scalp" ? c.tpPct : null],
  ["slPct", "Стоп, %", (c) => c.slMode === "pct" ? c.slPct : null],
  ["tpR", "Тейк, R", (c) => c.style !== "scalp" ? c.tpR : null],
  ["chaseAt", "Імпульс: старт", (c) => c.chase !== "off" ? c.chaseAt : null],
  ["chaseGap", "Імпульс: стоп позаду", (c) => c.chase !== "off" ? c.chaseGap : null],
  ["chaseStep", "Імпульс: крок тейку", (c) => c.chase !== "off" ? c.chaseStep : null],
  ["squeeze", "Фільтр стиснення", (c) => c.squeeze],
  ["relax", "Послаблення фільтрів", (c) => c.relax],
];
function perf() {
  const trades = JSON.parse(ev(`JSON.stringify(JOURNAL.filter(j => !j.noTrade).slice(-1000))`) || "[]");
  const withCfg = trades.filter(t => t.cfg);
  const roi = (t) => t.roi != null ? t.roi : (t.cfg && t.cfg.margin ? t.pnl / t.cfg.margin * 100 : 0);
  const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
  const params = OPT_KEYS.map(([key, name, get]) => {
    const g = {};
    for (const t of withCfg) { const v = get(t.cfg); if (v == null) continue; (g[v] = g[v] || []).push(t); }
    const rows = Object.entries(g).map(([v, ts]) => ({
      value: isNaN(Number(v)) ? v : Number(v), n: ts.length, win: Math.round(ts.filter(t => t.pnl > 0).length / ts.length * 100),
      avgRoi: +(sum(ts, roi) / ts.length).toFixed(2), pnl: +sum(ts, t => t.pnl).toFixed(4),
    })).sort((a, b) => b.avgRoi - a.avgRoi);
    const good = rows.filter(r => r.n >= OPT_MIN && r.avgRoi > 0);
    return { key, name, rows: rows.slice(0, 6), best: good[0] || null };
  });
  const byExit = {};
  for (const t of trades) { const k = t.result || "—"; (byExit[k] = byExit[k] || []).push(t); }
  const hours = {};
  for (const t of trades) { if (t.hour == null) continue; const b = Math.floor(t.hour / 6) * 6; const k = `${b}-${b + 6} UTC`; (hours[k] = hours[k] || []).push(t); }
  const pack = (o) => Object.entries(o).map(([k, ts]) => ({ value: k, n: ts.length, win: Math.round(ts.filter(t => t.pnl > 0).length / ts.length * 100), pnl: +sum(ts, t => t.pnl).toFixed(4) })).sort((a, b) => b.pnl - a.pnl);
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  return {
    total: trades.length, withSettings: withCfg.length, minTrades: OPT_MIN,
    win: trades.length ? Math.round(wins.length / trades.length * 100) : null,
    pnl: +sum(trades, t => t.pnl).toFixed(4),
    profitFactor: losses.length ? +(sum(wins, t => t.pnl) / Math.abs(sum(losses, t => t.pnl))).toFixed(2) : null,
    avgWinMovePct: wins.length ? +(sum(wins, t => t.movePct || 0) / wins.length).toFixed(2) : null,
    avgImpulseMaxPct: trades.some(t => t.maxGain) ? +(sum(trades.filter(t => t.maxGain), t => t.maxGain) / trades.filter(t => t.maxGain).length).toFixed(2) : null,
    params, byExit: pack(byExit), byHour: pack(hours),
  };
}
// apply the most profitable value of every setting (only with enough trades and a positive average)
function optimizeNow(source) {
  const P = perf();
  const cur = JSON.parse(ev("JSON.stringify(CFG)"));
  const changes = [];
  const style = P.params.find(p => p.key === "style").best;
  if (style && (style.value === "scalp") !== !!cur.scalp) { ev(`applyPreset(${JSON.stringify(style.value === "scalp" ? "scalp" : "normal")})`); changes.push(`стиль → ${style.value === "scalp" ? "скальпінг" : "пробої"} (${style.avgRoi}% на угоду, ${style.n} угод)`); }
  const fresh = JSON.parse(ev("JSON.stringify(CFG)"));
  const set = {};
  for (const p of P.params) {
    if (!p.best || p.key === "style" || p.key === "relax" || !LIMITS[p.key]) continue;
    const v = Math.min(LIMITS[p.key][1], Math.max(LIMITS[p.key][0], Number(p.best.value)));
    const curRow = p.rows.find(r => r.value === fresh[p.key]);
    if (v !== fresh[p.key] && (!curRow || p.best.avgRoi > curRow.avgRoi)) { set[p.key] = v; changes.push(`${p.name} ${fresh[p.key]} → ${v} (${p.best.avgRoi}% на угоду, ${p.best.n} угод, win ${p.best.win}%)`); }
  }
  if (Object.keys(set).length) ev(`Object.assign(CFG, ${JSON.stringify(set)}); LS.set("settings", CFG); buildSettings(); paintAuto();`);
  const text = changes.length ? `📈 Оптимізація (${source}, ${P.withSettings} угод): ` + changes.join("; ") : `📈 Оптимізація (${source}): змін немає — поточні налаштування вже найкращі або замало угод (треба ${OPT_MIN}+ з одним значенням)`;
  engineLog(text, changes.length ? "up" : "mute");
  lsSet("optLast", Date.now());
  return text;
}
const AUTO_OPT = () => !!lsGet("autoOpt", false);
setInterval(() => { if (AUTO_OPT() && !AI.on && Date.now() - lsGet("optLast", 0) >= 24 * 3600e3) { try { optimizeNow("авто раз на добу"); dumpStorage(); } catch (e) { log("optimize:", e.message); } } }, 10 * 60000);

const SYSTEM_FULL = `You have FULL control of this trading bot. The owner gave you the steering wheel 100%: there is no human in the loop.
Your only job is to grow the account. Your results are measured every period: "yourTrackRecord" lists your previous decisions and the
profit/loss the bot made in the period after each of them, and "performance" shows which settings made or lost money. Learn from it:
repeat what worked, stop what lost money, and say what you learned in "lesson". If your periods keep losing, the owner will switch you off,
so do everything possible to make each period profitable: choose the style, tune every setting, open trades yourself when you see a clear
setup, cancel waiting orders that no longer make sense, close positions that should be closed, or pause new entries when the market is bad.
Extra actions you may use:
 "open":[{"symbol":"SOLUSDT","side":"Buy|Sell","why":"..."}]  (max 3, enters now with a limit order, stop and take are set automatically)
 "cancel":["SYMBOL"]  (remove waiting breakout orders)
 settings may also contain: maxSetups, maxMode ("balance"|"fixed"), rocketScore, rocketTpR, tf (1,3,5,15,30,60), lookback, coins, minTurnover, trailR, nowLadder, margin.
Super scalping (order flow): "superscalp" shows its parameters, results by symbol/signal/take and live signals per coin
(imb = book imbalance 0..1, delta = tape buy-sell share, burst = 5 s volume vs normal, iceberg, absorption, spoof, long/short scores).
It enters with LIMIT orders at the best price and takes a short LIMIT take; the stop is on the exchange. You control it fully:
 "superscalp":{"on":true|false,"symbols":["BTCUSDT",...up to 12 liquid coins],"params":{tpPct,slPct,scoreIn,bandPct,burstX,wallX,spoofSec,icebergX,
   entryWaitSec,holdMaxSec,maxPositions,cooldownSec,dailyLossPct,margin,leverage,ride,useIceberg,useAbsorption,useSpoof,
   needAgree,cancelOnFade,flipExit,timeStopSec,adaptive,autoPrune,autoCoins,coinCount,minTurnoverM,pickEveryMin}}
With autoCoins the bot itself re-picks the most volatile liquid coins ("volatilityTop": rng1h = range of the last hour, %); send "symbols" only to override.
Use "byExit", "bySignal", "bySymbol" and "byTp" to see what loses money and fix exactly that.
Choose the most liquid, most active coins for it; tpPct must beat maker fees (0.04% round trip).
Each live coin has "why" (why there is no entry now) and "peakScore10min"; if super scalping is on but makes no trades for a long time,
lower scoreIn towards the typical peak scores or pick more active coins.
Add "lesson": one sentence in Ukrainian about what you learned from your track record.
`;
const SYSTEM = SYSTEM_FULL + `You are the risk-aware autopilot of a Bybit USDT-perpetual breakout bot. Every few minutes you receive the market state,
the bot's settings, open positions and the last closed trades, and you decide how the bot should trade for the next period.
The bot places Buy Stop above and Sell Stop below squeezed ranges; "scalp" = 5-minute ranges with a fixed take/stop in % of the entry;
"breakout" = 15-minute ranges with take in R (multiples of the risk). The impulse trailing (chase) moves the stop behind the price and pushes
the take further once chaseAt of the way to the take is covered.
Goals: positive expectancy after fees (~0.11% round trip), protect the account first, adapt to the regime (calm range vs trend vs high volatility).
You also get "performance": closed trades grouped by the settings they were opened with (n = trades, avgRoi = average result in % of
the trade margin, win = win rate). Prefer values that made money with n >= minTrades; move away from values that lose; with few trades
change settings carefully, one or two at a time.
Rules: take profit must be larger than fees; in scalp keep tpPct >= 0.3; a losing streak or a chaotic market is a reason to pause new entries
("pause") or to use stricter filters; never suggest removing stops. Close a position only with a clear reason (e.g. the move is exhausted while in profit).
Answer with ONE JSON object only, no text around it:
{"regime":"calm|range|trend|volatile|chaotic","mode":"scalp|breakout|pause","settings":{optional keys: tpPct,slPct,tpR,chaseAt,chaseGap,chaseStep,squeeze,maxEr,minWidth,maxWidth,scanMin,refreshMin,beR,expiryH,cooldownMin,leverage},
"close":["SYMBOL",...],"reason":"short explanation in Ukrainian (1-3 sentences)"}`;

function parseDecision(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI не повернув JSON");
  return JSON.parse(m[0]);
}

async function askAI(ctx) {
  const r = await fetch(FAL_URL, {
    method: "POST",
    headers: { Authorization: "Key " + FAL_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: FAL_MODEL, system_prompt: SYSTEM, prompt: "State:\n" + JSON.stringify(ctx), temperature: 0.2, max_tokens: 800 }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`fal ${r.status}: ${j.error || j.detail && JSON.stringify(j.detail).slice(0, 200) || "помилка"}`);
  return parseDecision(j.output);
}

async function applyDecision(d) {
  const changes = [];
  const cur = JSON.parse(ev("JSON.stringify(CFG)"));
  const mode = ["scalp", "breakout", "pause"].includes(d.mode) ? d.mode : null;
  if (mode === "scalp" && !cur.scalp) { ev(`applyPreset("scalp")`); changes.push("стиль → скальпінг"); }
  if (mode === "breakout" && cur.scalp) { ev(`applyPreset("normal")`); changes.push("стиль → пробої"); }
  const pause = mode === "pause";
  if (pause !== !!cur.aiPause) { ev(`CFG.aiPause = ${pause}`); changes.push(pause ? "нові входи на паузі" : "нові входи знову увімкнено"); }
  const set = {};
  for (const [k, v] of Object.entries(d.settings || {})) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (k === "maxMode") continue;
    if (k === "margin") {
      const cap = Number(process.env.AI_MAX_MARGIN) || AI.maxMargin || cur.margin;   // the AI never risks more per trade than this
      const m = Math.max(1, Math.min(cap, +n.toFixed(2)));
      if (m !== cur.margin) set.margin = m;
      continue;
    }
    if (k === "tf") { const tf = TF_OK.reduce((a, b) => Math.abs(b - n) < Math.abs(a - n) ? b : a, 5); if (tf !== cur.tf) set.tf = tf; continue; }
    if (k === "leverage") {
      const cap = AI.maxLev || cur.leverage;
      const lev = Math.max(1, Math.min(cap, Math.round(n)));
      if (lev !== cur.leverage) set.leverage = lev;
      continue;
    }
    if (!LIMITS[k]) continue;
    const val = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], INT_KEYS.has(k) ? Math.round(n) : +n.toFixed(3)));
    if (val !== cur[k]) set[k] = val;
  }
  if (d.settings && ["balance", "fixed"].includes(d.settings.maxMode) && d.settings.maxMode !== cur.maxMode) set.maxMode = d.settings.maxMode;
  const fresh = JSON.parse(ev("JSON.stringify(CFG)"));
  if (fresh.scalp && set.tpPct != null) set.tpPct = Math.max(0.3, set.tpPct);
  if (Object.keys(set).length) {
    ev(`Object.assign(CFG, ${JSON.stringify(set)}); LS.set("settings", CFG); buildSettings(); paintAuto();`);
    changes.push(Object.entries(set).map(([k, v]) => `${k} ${fresh[k]}→${v}`).join(", "));
  }
  // close positions the AI wants out of (only real open positions)
  const open = JSON.parse(ev("JSON.stringify(POS.map(p => ({ symbol: p.symbol, side: p.side, size: p.size, idx: Number(p.positionIdx || 0) })))") || "[]");
  for (const sym of (Array.isArray(d.close) ? d.close : []).slice(0, 10)) {
    const p = open.find(x => x.symbol === String(sym).toUpperCase());
    if (!p) continue;
    try {
      await ev(`bx("/v5/order/create", { method: "POST", auth: true, body: { category: "linear", symbol: ${JSON.stringify(p.symbol)}, side: ${JSON.stringify(p.side === "Buy" ? "Sell" : "Buy")}, orderType: "Market", qty: ${JSON.stringify(p.size)}, reduceOnly: true, timeInForce: "IOC", positionIdx: ${p.idx} } })`);
      changes.push(`закрито ${p.symbol}`);
    } catch (e) { changes.push(`не закрив ${p.symbol}: ${e.message}`); }
  }
  // super scalping: on/off, coins and every parameter (margin and leverage capped like everything else)
  if (d.superscalp && typeof d.superscalp === "object") {
    const ssc = SS.setParams(Object.assign({}, d.superscalp.params || {}, Array.isArray(d.superscalp.symbols) ? { symbols: d.superscalp.symbols } : {}),
      { margin: AI.maxMargin || cur.margin, leverage: AI.maxLev || cur.leverage });
    if (ssc.length) changes.push("суперскальпінг: " + ssc.join(", "));
    if (typeof d.superscalp.on === "boolean" && d.superscalp.on !== SS.params.on) { SS.setOn(d.superscalp.on); changes.push(d.superscalp.on ? "суперскальпінг увімкнено" : "суперскальпінг вимкнено"); }
  }
  // cancel waiting breakout orders the AI no longer wants
  for (const sym of (Array.isArray(d.cancel) ? d.cancel : []).slice(0, 30)) {
    const S = String(sym).toUpperCase();
    try {
      const done = await ev(`(async () => { const s = SETUPS.find(x => x.symbol === ${JSON.stringify(S)} && x.state === "armed"); if (!s) return false;
        await cancelAll(s); await cancelDip(s); SETUPS = SETUPS.filter(x => x !== s); saveSetups(); return true; })()`);
      if (done) changes.push(`знято заявки ${S}`);
    } catch (e) { changes.push(`не зняв ${S}: ${e.message}`); }
  }
  // trades the AI opens itself (stop and take are set by the bot)
  if (!ev("CFG.aiPause")) {
    for (const o of (Array.isArray(d.open) ? d.open : []).slice(0, 3)) {
      const sym = String(o && o.symbol || "").toUpperCase(), side = o && /sell|short/i.test(o.side) ? "Sell" : "Buy";
      if (!/^[A-Z0-9]{2,30}USDT$/.test(sym)) continue;
      try {
        await ev(`enterNow(${JSON.stringify(sym)}, ${JSON.stringify(side)}, { score: null, reasons: [${JSON.stringify("AI: " + String(o.why || "").slice(0, 120))}] }, { kind: "ai" })`);
        changes.push(`AI відкрив ${side === "Buy" ? "лонг" : "шорт"} ${sym}`);
      } catch (e) { changes.push(`не відкрив ${sym}: ${e.message}`); }
    }
  }
  return changes;
}

// result of the period after the last AI decision: closed trades and equity change until now
function closePeriod() {
  const h = AI.history[AI.history.length - 1];
  if (!h || h.closed) return;
  const trades = JSON.parse(ev(`JSON.stringify(JOURNAL.filter(j => !j.noTrade && j.closedAt >= ${h.at}).map(j => j.pnl))`) || "[]");
  h.periodPnl = +trades.reduce((a, x) => a + Number(x || 0), 0).toFixed(4);
  h.periodTrades = trades.length;
  h.periodWins = trades.filter(x => x > 0).length;
  if (h.equity && ACC.equity) h.periodEquity = +(ACC.equity - h.equity).toFixed(4);
  h.closed = true;
}

async function aiTick(force) {
  if (!AI.on || AI.busy) return;
  if (!force && Date.now() - AI.last < AI_EVERY * 60000) return;
  if (!FAL_KEY) { AI.error = "немає FAL_KEY у Railway → Variables"; return; }
  AI.busy = true; AI.last = Date.now();
  try {
    closePeriod();
    const ctx = Object.assign({ time: new Date().toISOString() }, await marketContext(), botContext(), {
      performance: perf(),
      account: { equity: ACC.equity, available: ACC.available },
      superscalp: SS.aiView(),
      yourTrackRecord: AI.history.slice(-12).map(h => ({ at: new Date(h.at).toISOString(), mode: h.mode, regime: h.regime, changes: h.changes, lesson: h.lesson || "",
        periodPnlUsdt: h.periodPnl ?? null, periodTrades: h.periodTrades ?? null, periodWins: h.periodWins ?? null, equityAtDecision: h.equity ?? null })),
    });
    const d = await askAI(ctx);
    const changes = await applyDecision(d);
    const item = { at: Date.now(), regime: d.regime || "", mode: d.mode || "", reason: String(d.reason || "").slice(0, 400), lesson: String(d.lesson || "").slice(0, 300), changes, equity: ACC.equity };
    AI.history.push(item); AI.error = "";
    engineLog(`🧠 AI: ${item.regime} · ${item.mode} — ${item.reason}${changes.length ? " · зміни: " + changes.join("; ") : " · без змін"}`);
    log("AI decision", JSON.stringify(item));
  } catch (e) {
    AI.error = String(e && e.message || e);
    engineLog(`🧠 AI: помилка — ${AI.error}. Бот торгує з поточними налаштуваннями.`, "down");
  } finally { AI.busy = false; saveAI(); dumpStorage(); }
}
setInterval(() => aiTick(false), 30000);

// ---------------- super scalping by order flow ----------------
const SS = require("./superscalp").create({ ev, log, engineLog, lsGet, lsSet, env: ENV, testWs: (process.env.TEST_WS_URL || "").trim() });

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
    ai: { on: AI.on, busy: AI.busy, key: !!FAL_KEY, model: FAL_MODEL, every: AI_EVERY, error: AI.error, maxLev: AI.maxLev,
      next: AI.on ? Math.max(0, Math.round((AI.last + AI_EVERY * 60000 - Date.now()) / 1000)) : null, history: AI.history.slice(-5).reverse() },
    aiPause: !!ev("CFG.aiPause"),
    perf: perf(), autoOpt: AUTO_OPT(), progress: progress(), ss: SS.view(),
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
    if (SS.params.on) SS.setOn(false);
    if (AI.on) { AI.on = false; ev("CFG.aiPause = false"); saveAI(); }
  } else if (what === "ai") {
    if (!FAL_KEY) return "Додайте FAL_KEY (ключ fal.ai) у Railway → Variables, потім увімкніть AI";
    AI.on = !AI.on;
    if (AI.on) {
      AI.last = Date.now();   // the timer waits; the first decision is made right below, once the bot runs
      AI.maxLev = Number(process.env.AI_MAX_LEVERAGE) || ev("CFG.leverage");   // the AI never raises leverage above this
      AI.maxMargin = Number(process.env.AI_MAX_MARGIN) || ev("CFG.margin");     // nor the margin per trade
      if (!ev("RUN") || !ev("CFG.autopilot")) { if (!ev("CFG.autopilot")) click("btn-auto"); else click("btn-start"); }
      await new Promise(r => setTimeout(r, 2500));
      if (!ev("RUN")) { AI.on = false; saveAI(); return "Бот не запустився: " + (ev(`document.getElementById("note-err").textContent`) || "перевірте ключі Bybit"); }
      engineLog("🧠 AI-автопілот увімкнено: модель " + FAL_MODEL + ", рішення кожні " + AI_EVERY + " хв", "up");
      saveAI(); aiTick(true);
    } else {
      ev("CFG.aiPause = false");
      engineLog("🧠 AI-автопілот вимкнено: бот лишається на звичайному автопілоті", "mute");
      saveAI();
    }
    return "OK";
  } else if (what === "ss") {
    if (!HAS_KEYS) return "Немає ключів Bybit";
    SS.setOn(!SS.params.on);
    return "OK";
  } else if (what === "optimize") {
    return optimizeNow("кнопка");
  } else if (what === "autoopt") {
    lsSet("autoOpt", !AUTO_OPT()); dumpStorage();
    return AUTO_OPT() ? "Авто-оптимізація раз на добу увімкнена (коли AI вимкнено; з AI оптимізує сам AI)" : "Авто-оптимізацію вимкнено";
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
.ai{background:transparent;border:2px solid #a78bfa;color:#c4b5fd;min-height:60px;font-size:18px}.ai.on{background:#7c3aed;border-color:#7c3aed;color:#fff}
.mini{min-height:36px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--ink);padding:0 10px;font-size:12px;cursor:pointer}.mini.on{border-color:var(--up);color:var(--up)}
.chip{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:1px 6px;margin:2px;font:11px ui-monospace,monospace}
.ss{background:transparent;border:2px solid #22d3ee;color:#67e8f9;min-height:60px;font-size:18px}.ss.on{background:#0891b2;border-color:#0891b2;color:#fff}
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
<div style="margin-top:10px"><button class="big ai" id="ai">🧠 AI-автопілот</button></div>
<div id="aiLine" style="font-size:13px;margin-top:6px"></div>
<div style="margin-top:10px"><button class="big sc" id="scalp">⚡ Скальпінг</button></div>
<div style="margin-top:10px"><button class="big ss" id="ss">⚡⚡ Суперскальпінг (стакан)</button></div>
<div id="ssLine" style="font-size:13px;margin-top:6px"></div>
<div id="chaseLine" style="font-size:13px;margin-top:10px"></div>
<div class="mute" id="scalpHint" style="font-size:12px;margin-top:6px">Скальпінг: короткі угоди, тейк +0.5%, стоп −1% від входу, скан щохвилини.</div>
<div id="warn"></div></div>
<div class="card row">
<div class="k"><span>Капітал, USDT</span><b id="eq">—</b></div><div class="k"><span>Вільно</span><b id="av">—</b></div>
<div class="k"><span>Сьогодні угод / PnL</span><b id="td">—</b></div><div class="k"><span>Усього угод · win</span><b id="all">—</b></div></div>
<div class="card"><b>Позиції</b><div class="scroll"><table><thead><tr><th>Монета</th><th>Бік</th><th>Вхід</th><th>Ціна</th><th>PnL</th><th>Стоп / Тейк</th><th>Імпульс</th></tr></thead><tbody id="pos"></tbody></table></div></div>
<div class="card"><b>Заявки бота на біржі</b><div class="scroll"><table><thead><tr><th>Монета</th><th>Стан</th><th>Buy Stop</th><th>Sell Stop</th></tr></thead><tbody id="set"></tbody></table></div></div>
<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><b>📈 Що приносить прибуток</b>
<span><button class="mini" id="opt">Застосувати найприбутковіші</button> <button class="mini" id="autoopt">Авто раз на добу</button></span></div>
<div class="mute" id="perfSum" style="font-size:13px;margin-top:6px"></div><div id="perfRows" style="margin-top:6px"></div></div>
<div class="card" id="ssCard"><b>⚡⚡ Суперскальпінг: стакан і стрічка наживо</b><div class="mute" id="ssSum" style="font-size:13px;margin-top:4px"></div>
<div class="scroll"><table><thead><tr><th>Монета</th><th>Стакан</th><th>Дельта</th><th>Сплеск</th><th>Сигнали</th><th>Лонг</th><th>Шорт</th><th>Макс 10 хв</th><th>Чому немає входу</th></tr></thead><tbody id="ssLive"></tbody></table></div>
<div class="scroll" style="margin-top:8px"><table><thead><tr><th>Угода</th><th>Стан</th><th>Вхід</th><th>Тейк</th><th>Стоп</th><th>с</th></tr></thead><tbody id="ssOpen"></tbody></table></div>
<div class="log" id="ssTrades" style="margin-top:6px"></div></div>
<div class="card"><b>🧠 Прогрес AI</b><div class="mute" id="progSum" style="font-size:13px;margin-top:4px"></div>
<div style="font-size:12px;margin-top:8px" class="mute">Капітал, USDT · фіолетові лінії — рішення AI</div><svg id="eqChart" viewBox="0 0 600 180" style="width:100%;height:180px;display:block"></svg>
<div style="font-size:12px;margin-top:8px" class="mute">Результат кожного періоду після рішення AI (USDT) · лінія — накопичено</div><svg id="decChart" viewBox="0 0 600 150" style="width:100%;height:150px;display:block"></svg></div>
<div class="card" id="aiCard" style="display:none"><b>🧠 Рішення AI</b><div id="aiHist" class="log"></div></div>
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
const A=S.ai||{};const ab=$("ai");ab.className="big ai"+(A.on?" on":"");ab.disabled=busy||A.busy;
ab.textContent=A.on?(A.busy?"🧠 AI думає…":"🧠 AI-автопілот увімкнено"):"🧠 AI-автопілот";
$("aiLine").innerHTML=!A.key?'<span class="down">Для AI додайте FAL_KEY у Railway → Variables</span>':A.on?'<span style="color:#c4b5fd">Модель '+esc(A.model)+" · наступне рішення через "+Math.round((A.next||0)/60)+" хв"+(S.aiPause?' · <b>нові входи на паузі (рішення AI)</b>':"")+(A.maxLev?" · плече не вище x"+A.maxLev:"")+"</span>"+(A.error?'<br><span class="down">'+esc(A.error)+"</span>":""):'<span class="mute">AI кожні '+A.every+" хв аналізує ринок, рахунок і угоди та сам міняє стиль (скальпінг / пробої / пауза), тейк, стоп, трейлінг і фільтри</span>";
$("aiCard").style.display=(A.history||[]).length?"":"none";
$("aiHist").innerHTML=(A.history||[]).map(h=>"<div>"+new Date(h.at).toLocaleTimeString()+' · <b style="color:#c4b5fd">'+esc(h.regime)+" · "+esc(h.mode)+"</b> — "+esc(h.reason)+(h.lesson?'<br><span style="color:#c4b5fd">Урок: '+esc(h.lesson)+"</span>":"")+(h.changes&&h.changes.length?'<br><span class="up">'+esc(h.changes.join("; "))+"</span>":"")+"</div>").join("");
$("scalpHint").textContent="Скальпінг: короткі угоди, тейк +"+(S.scalp?S.tp:0.5)+"%, стоп −"+(S.scalp?S.sl:1)+"% від входу, скан щохвилини.";
const P=S.perf||{};
$("perfSum").innerHTML=P.total?("Угод "+P.total+" · win "+P.win+"% · PnL "+(P.pnl>=0?'<span class="up">+':'<span class="down">')+f(P.pnl,4)+"</span> USDT"+(P.profitFactor!=null?" · PF "+P.profitFactor:"")+(P.avgWinMovePct!=null?" · середній виграш +"+P.avgWinMovePct+"%":"")+(P.avgImpulseMaxPct!=null?" · середній імпульс +"+P.avgImpulseMaxPct+"%":"")+" · з налаштуваннями "+P.withSettings+" (для висновку треба "+P.minTrades+"+ угод з одним значенням)"):"Ще немає закритих угод — статистика з'явиться після перших угод.";
$("perfRows").innerHTML=(P.params||[]).filter(p=>p.rows.length).map(p=>'<div style="margin-top:6px;font-size:13px"><b>'+esc(p.name)+"</b>"+(p.best?' · <span class="up">найкраще '+esc(p.best.value)+"</span>":"")+"<br>"+p.rows.map(r=>'<span class="chip '+(r.avgRoi>=0?"up":"down")+'">'+esc(r.value)+": "+(r.avgRoi>=0?"+":"")+r.avgRoi+"% · "+r.n+" уг. · "+r.win+"%</span>").join("")+"</div>").join("")+((P.byExit||[]).length?'<div style="margin-top:6px;font-size:13px"><b>Чим закрились</b><br>'+P.byExit.map(r=>'<span class="chip '+(r.pnl>=0?"up":"down")+'">'+esc(r.value)+": "+r.n+" · "+(r.pnl>=0?"+":"")+r.pnl+"</span>").join("")+"</div>":"")+((P.byHour||[]).length?'<div style="margin-top:6px;font-size:13px"><b>Години</b><br>'+P.byHour.map(r=>'<span class="chip '+(r.pnl>=0?"up":"down")+'">'+esc(r.value)+": "+r.n+" · "+(r.pnl>=0?"+":"")+r.pnl+"</span>").join("")+"</div>":"");
$("autoopt").className="mini"+(S.autoOpt?" on":"");$("autoopt").textContent=S.autoOpt?"Авто раз на добу: увімк":"Авто раз на добу";
drawProgress(S.progress||{});
const X=S.ss||{},XP=X.params||{},XS=X.stats||{};const sb=$("ss");sb.className="big ss"+(XP.on?" on":"");sb.disabled=busy;
sb.textContent=XP.on?"⚡⚡ Суперскальпінг увімкнено":"⚡⚡ Суперскальпінг (стакан)";
$("ssLine").innerHTML=(XP.on?'<span style="color:#67e8f9">':'<span class="mute">')+"Стакан, стрічка, айсберги, поглинання, спуфінг · вхід і тейк лімітками · тейк "+XP.tpPct+"% · стоп "+XP.slPct+"% · до "+XP.maxPositions+" угод · "+(X.ws?"дані наживо ✓":"підключаюсь до біржі…")+(X.stoppedForDay?' · <b class="down">денний ліміт збитку — пауза до завтра</b>':"")+"</span>"+(X.err?'<br><span class="down">'+esc(X.err)+"</span>":"");
$("ssSum").innerHTML=(XP.autoCoins?'<span style="color:#67e8f9">Монети: топ волатильності (оновлення кожні '+XP.pickEveryMin+" хв)"+((X.vol||[]).length?" — "+X.vol.slice(0,XP.coinCount).map(v=>esc(v.sym)+" "+v.rng1h+"%/год").join(", "):"")+"</span><br>":"")+"Угод "+(XS.n||0)+(XS.win!=null?" · win "+XS.win+"%":"")+" · PnL "+f(XS.pnl,4)+" · за добу "+(XS.day||0)+" угод "+f(XS.dayPnl,4)+(XS.avgHold!=null?" · середня угода "+XS.avgHold+" с":"")+" · монети: "+esc((XP.symbols||[]).join(", "));
$("ssLive").innerHTML=(X.live||[]).map(l=>{const sg=[l.iceBid?"айсберг↑":"",l.iceAsk?"айсберг↓":"",l.absBull?"поглин.↑":"",l.absBear?"поглин.↓":"",l.spoofBid?"спуф bid":"",l.spoofAsk?"спуф ask":""].filter(Boolean).join(" ");
return "<tr><td><b>"+esc(l.sym)+'</b></td><td class="'+(l.imb>=0.5?"up":"down")+'">'+(l.imb??"—")+'</td><td class="'+(l.delta>=0?"up":"down")+'">'+(l.delta??"—")+"</td><td>"+(l.burst!=null?"×"+l.burst:"—")+"</td><td>"+(sg||'<span class="mute">—</span>')+'</td><td class="'+(l.long>=XP.scoreIn?"up":"")+'">'+(l.long??"—")+'</td><td class="'+(l.short>=XP.scoreIn?"down":"")+'">'+(l.short??"—")+"</td><td>"+(l.peak10!=null?l.peak10:"—")+'</td><td class="mute">'+esc(l.why||"")+"</td></tr>"}).join("")||'<tr><td colspan="9" class="mute">Чекаю дані стакану…</td></tr>';
$("ssOpen").innerHTML=(X.open||[]).map(o=>"<tr><td><b>"+esc(o.sym)+'</b> <span class="'+(o.side==="Buy"?"up":"down")+'">'+(o.side==="Buy"?"лонг":"шорт")+"</span></td><td>"+(o.state==="entry"?"чекає виконання ліміту":"в угоді"+(o.rides?" · імпульс ×"+o.rides:""))+"</td><td>"+esc(o.entry)+"</td><td>"+esc(o.tp||"—")+"</td><td>"+esc(o.sl||"—")+"</td><td>"+o.sec+"</td></tr>").join("")||'<tr><td colspan="6" class="mute">Відкритих угод суперскальпінгу немає</td></tr>';
$("ssTrades").innerHTML=(X.trades||[]).map(t=>"<div>"+new Date(t.closedAt).toLocaleTimeString()+" · "+esc(t.sym)+" "+(t.side==="Buy"?"лонг":"шорт")+" · "+esc(t.how)+' · <span class="'+(t.pnl>=0?"up":"down")+'">'+(t.pnl>=0?"+":"")+t.pnl+"</span> · "+t.holdSec+" с</div>").join("");
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
$("ai").onclick=()=>act("ai",S&&S.ai&&!S.ai.on?"Увімкнути AI-автопілот? AI сам керуватиме стилем торгівлі, тейком, стопом, фільтрами і може закривати позиції. Маржу не змінює, плече не піднімає вище поточного. Прибуток не гарантовано.":"");
function drawProgress(G){const W=600;
const eq=G.eq||[],dec=G.dec||[];
const q=G.quality,al=G.avgLast,ap=G.avgPrev;
$("progSum").innerHTML=G.periods?("Періодів AI: "+G.periods+" · разом "+(G.totalPnl>=0?'<span class="up">+':'<span class="down">')+f(G.totalPnl,4)+"</span> USDT · якість останніх 10: "+(q==null?"—":'<b class="'+(q>=50?"up":"down")+'">'+q+"%</b> у плюсі")+(al!=null&&ap!=null?" · середній період "+(al>=ap?'<span class="up">покращився':'<span class="down">погіршився')+"</span> ("+f(ap,4)+" → "+f(al,4)+")":"")):"Графік наповнюватиметься: капітал записується кожні 10 хв, а кожне рішення AI отримує результат свого періоду.";
let svg="";if(eq.length>1){const t0=eq[0][0],t1=eq[eq.length-1][0]||t0+1,vs=eq.map(p=>p[1]),lo=Math.min(...vs),hi=Math.max(...vs),pad=(hi-lo)*0.1||1;
const X=t=>10+(t-t0)/(t1-t0||1)*(W-20),Y=v=>170-(v-(lo-pad))/((hi+pad)-(lo-pad))*160;
dec.forEach(d=>{if(d.at>=t0&&d.at<=t1)svg+='<line x1="'+X(d.at)+'" x2="'+X(d.at)+'" y1="5" y2="172" stroke="#7c3aed" stroke-opacity=".45" stroke-width="1"/>'});
svg+='<polyline fill="none" stroke="'+(vs[vs.length-1]>=vs[0]?"#0ecb81":"#f6465d")+'" stroke-width="2" points="'+eq.map(p=>X(p[0]).toFixed(1)+","+Y(p[1]).toFixed(1)).join(" ")+'"/>';
svg+='<text x="12" y="14" fill="#848e9c" font-size="11">'+f(hi,2)+'</text><text x="12" y="168" fill="#848e9c" font-size="11">'+f(lo,2)+"</text>"}
else svg='<text x="12" y="90" fill="#848e9c" font-size="13">Ще мало точок капіталу</text>';$("eqChart").innerHTML=svg;
const done=dec.filter(d=>d.pnl!=null).slice(-60);let s2="";
if(done.length){const mx=Math.max(...done.map(d=>Math.abs(d.pnl)),1e-9);let cum=0;const cums=done.map(d=>cum+=d.pnl),cm=Math.max(...cums.map(Math.abs),1e-9);
const bw=(W-20)/done.length,mid=75;
done.forEach((d,i)=>{const h=Math.abs(d.pnl)/mx*65;s2+='<rect x="'+(10+i*bw+1).toFixed(1)+'" y="'+(d.pnl>=0?mid-h:mid).toFixed(1)+'" width="'+Math.max(1,bw-2).toFixed(1)+'" height="'+Math.max(1,h).toFixed(1)+'" fill="'+(d.pnl>=0?"#0ecb81":"#f6465d")+'"><title>'+new Date(d.at).toLocaleString()+" · "+d.mode+" · "+(d.pnl>=0?"+":"")+d.pnl+" USDT · угод "+d.trades+"</title></rect>"});
s2+='<line x1="10" x2="590" y1="'+mid+'" y2="'+mid+'" stroke="#2b3139"/>';
s2+='<polyline fill="none" stroke="#c4b5fd" stroke-width="2" points="'+cums.map((c,i)=>(10+i*bw+bw/2).toFixed(1)+","+(mid-c/cm*65).toFixed(1)).join(" ")+'"/>'}
else s2='<text x="12" y="75" fill="#848e9c" font-size="13">Перший результат з&#39;явиться після другого рішення AI</text>';
$("decChart").innerHTML=s2;}
$("ss").onclick=()=>act("ss",S&&S.ss&&!S.ss.params.on?"Увімкнути суперскальпінг за стаканом? Вхід і тейк лімітками, стоп на біржі, до "+S.ss.params.maxPositions+" угод одночасно, денний ліміт збитку "+S.ss.params.dailyLossPct+"%.":"");
$("opt").onclick=()=>act("optimize","Застосувати найприбутковіші налаштування за статистикою угод?");
$("autoopt").onclick=()=>act("autoopt","");
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
    if (req.method === "POST" && /^\/api\/(start|stop|scalp|ai|optimize|autoopt|ss)$/.test(url.pathname)) {
      if (!PASSWORD) return json(200, { text: "Задайте UI_PASSWORD у Railway → Variables, щоб керувати ботом" });
      return json(200, { text: await act(url.pathname.split("/").pop()) });
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(PAGE);
  } catch (e) { return json(500, { text: String(e && e.message || e) }); }
}).listen(PORT, "0.0.0.0", () => log(`Proboy Autopilot :${PORT} · ${ENV} · keys ${HAS_KEYS ? "yes" : "no"} · ${PASSWORD ? "password on" : "NO UI_PASSWORD (buttons locked)"} · storage ${STORE}`));
