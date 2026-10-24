// Super scalping by order flow: live order book (50 levels, 20 ms) and trade tape from Bybit WebSocket.
// Signals: book imbalance, tape delta and bursts, icebergs, absorption, spoofing (walls pulled before being traded), impulse.
// Entries and takes are LIMIT orders (PostOnly = maker). The stop sits on the exchange (stop-market, so it always executes).
// Every parameter can be set by the AI autopilot.
"use strict";

const WebSocket = require("ws");

const DEFAULTS = {
  on: false,
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "SUIUSDT"],
  margin: 5, leverage: 10,
  tpPct: 0.2,            // take, % from the entry (limit, maker)
  slPct: 0.3,            // stop, % from the entry (on the exchange)
  scoreIn: 0.5,          // signal strength needed to enter (0..1)
  bandPct: 0.15,         // book depth used for the imbalance, % from mid
  burstX: 2.5,           // tape burst: 5 s volume vs normal
  wallX: 6,              // a wall: level size vs median level
  spoofSec: 4,           // a wall pulled within this time without trades = spoof
  icebergX: 3,           // traded at a level vs its visible size = iceberg
  entryWaitSec: 8,       // an unfilled entry limit is cancelled after this
  holdMaxSec: 300,       // after this the take is pulled to the best price to get out
  maxPositions: 2,
  cooldownSec: 60,
  dailyLossPct: 3,       // super scalping stops for the day after this loss, % of equity
  ride: true,            // move the take further while the impulse goes on
  useIceberg: true, useAbsorption: true, useSpoof: true,
};

function create({ ev, log, engineLog, lsGet, lsSet, env, testWs }) {
  const P = Object.assign({}, DEFAULTS, lsGet("ss", {}));
  if (!P.v) { if (P.scoreIn === 0.6 || P.scoreIn === 0.62) P.scoreIn = DEFAULTS.scoreIn; P.v = 2; }   // the first threshold was too strict for the live market
  const ST = { hedge: !!lsGet("ssHedge", false), trades: lsGet("ssTrades", []), dayStart: 0, dayPnl: 0, stoppedForDay: false, wsUp: false, lastMsg: 0, err: "" };
  const M = {};           // per symbol market state
  const POSN = {};        // our live entries/positions per symbol
  const COOL = {};
  let ws = null, pingT = null, reconnectT = null;
  const save = () => { lsSet("ss", P); lsSet("ssTrades", ST.trades.slice(-500)); };

  // ---------------- market data ----------------
  function mk(sym) {
    return M[sym] || (M[sym] = { bids: new Map(), asks: new Map(), tape: [], walls: new Map(), traded: new Map(), shown: new Map(),
      spoofs: [], icebergs: [], prices: [], bid: 0, ask: 0, last: 0, tick: 0, ready: false });
  }
  function applyBook(sym, d, snapshot) {
    const m = mk(sym);
    if (snapshot) { m.bids.clear(); m.asks.clear(); m.walls.clear(); }   // a full book: no wall history to compare with
    const now = Date.now();
    for (const [side, book, key] of [["Buy", m.bids, "b"], ["Sell", m.asks, "a"]]) {
      for (const [ps, ss] of d[key] || []) {
        const size = Number(ss), price = Number(ps);
        const prev = book.get(price) || 0;
        if (size === 0) book.delete(price); else book.set(price, size);
        m.shown.set(side + price, Math.max(m.shown.get(side + price) || 0, size));
        // spoofing: a big wall that disappears quickly with almost nothing traded at that price
        const w = m.walls.get(side + price);
        if (w && (size === 0 || size < w.size * 0.3)) {
          const traded = m.traded.get(side + price) || 0;
          // the price went through the wall = it was eaten, not pulled
          const crossed = m.last && (side === "Buy" ? m.last <= price : m.last >= price);
          if (!snapshot && !crossed && now - w.t < P.spoofSec * 1000 && traded < w.size * 0.2) m.spoofs.push({ side, price, size: w.size, t: now });
          m.walls.delete(side + price);
        } else if (!w && !snapshot && size > 0 && size > prev * 3) {   // a level suddenly grew: maybe a wall
          // remember new big levels as walls (checked against the median below)
          m.walls.set(side + price, { size, t: now, pending: true });
        }
      }
    }
    const bb = Math.max(...m.bids.keys(), 0), ba = Math.min(...m.asks.keys(), Infinity);
    if (bb > 0 && ba < Infinity) { m.bid = bb; m.ask = ba; m.ready = true; }
    if (!m.tick && m.bids.size > 2) {
      const ps = [...m.bids.keys()].sort((a, b) => b - a);
      m.tick = Math.min(...ps.slice(0, 10).map((p, i, a) => i ? +(a[i - 1] - p).toFixed(10) : Infinity).filter(x => x > 0)) || 0;
    }
    // keep only real walls: size >= wallX x median level size
    const sizes = [...m.bids.values(), ...m.asks.values()].sort((a, b) => a - b);
    const med = sizes[Math.floor(sizes.length / 2)] || 0;
    for (const [k, w] of m.walls) {
      if (w.pending) { if (w.size >= P.wallX * med && med > 0) w.pending = false; else m.walls.delete(k); }
    }
    m.spoofs = m.spoofs.filter(x => now - x.t < 60000);
  }
  function applyTrades(sym, list) {
    const m = mk(sym), now = Date.now();
    for (const t of list) {
      const p = Number(t.p), v = Number(t.v);
      m.tape.push({ t: Number(t.T) || now, side: t.S, usd: p * v, p, v });
      const lvlSide = t.S === "Sell" ? "Buy" : "Sell";           // a market sell hits the bid, a market buy lifts the ask
      m.traded.set(lvlSide + p, (m.traded.get(lvlSide + p) || 0) + v);
      m.last = p;
      // iceberg: much more traded against a level than was ever shown there, and the level is still standing
      const shown = m.shown.get(lvlSide + p) || 0;
      const stillThere = (lvlSide === "Buy" ? m.bids : m.asks).has(p);
      const done = m.traded.get(lvlSide + p);
      if (shown > 0 && stillThere && done > P.icebergX * shown && !m.icebergs.some(x => x.price === p && now - x.t < 20000)) {
        m.icebergs.push({ side: lvlSide, price: p, traded: done, shown, t: now });
      }
    }
    m.prices.push([now, m.last]);
    const cut = now - 60000;
    m.tape = m.tape.filter(x => x.t >= cut);
    m.prices = m.prices.filter(x => x[0] >= cut);
    m.icebergs = m.icebergs.filter(x => now - x.t < 60000);
    if (m.traded.size > 4000) m.traded.clear();
  }

  // ---------------- signals ----------------
  function signals(sym) {
    const m = M[sym];
    if (!m || !m.ready || !m.last) return null;
    const now = Date.now(), mid = (m.bid + m.ask) / 2, band = mid * P.bandPct / 100;
    let bs = 0, as = 0;
    for (const [p, s] of m.bids) if (p >= mid - band) bs += s * p;
    for (const [p, s] of m.asks) if (p <= mid + band) as += s * p;
    const imb = bs + as > 0 ? bs / (bs + as) : 0.5;
    const win = (ms) => m.tape.filter(x => x.t >= now - ms);
    const sum = (a, side) => a.filter(x => !side || x.side === side).reduce((s, x) => s + x.usd, 0);
    const t5 = win(5000), t10 = win(10000);
    const buy5 = sum(t5, "Buy"), sell5 = sum(t5, "Sell"), vol5 = buy5 + sell5;
    // normal 5 s volume over the time we actually have (up to a minute); no signals until 20 s of tape
    const covered = m.tape.length ? Math.min(60000, now - m.tape[0].t) : 0;
    if (covered < 20000) return null;
    const base = sum(m.tape) / Math.max(1, covered / 5000) || 1;
    const burst = vol5 / base;
    const delta = vol5 ? (buy5 - sell5) / vol5 : 0;
    const p10 = (m.prices.find(x => x[0] >= now - 10000) || [0, m.last])[1];
    const move10 = p10 ? (m.last - p10) / p10 * 100 : 0;
    const buy10 = sum(t10, "Buy"), sell10 = sum(t10, "Sell");
    // absorption: heavy aggression one way but the price does not give in
    const heavy = (buy10 + sell10) / (base * 2) > P.burstX;
    const absBull = P.useAbsorption && heavy && sell10 > buy10 * 1.8 && move10 >= -0.02;
    const absBear = P.useAbsorption && heavy && buy10 > sell10 * 1.8 && move10 <= 0.02;
    const ice = P.useIceberg ? m.icebergs.filter(x => now - x.t < 20000 && Math.abs(x.price - mid) / mid < 0.003) : [];
    const iceBid = ice.some(x => x.side === "Buy"), iceAsk = ice.some(x => x.side === "Sell");
    const sp = P.useSpoof ? m.spoofs.filter(x => now - x.t < 20000) : [];
    const spoofBid = sp.filter(x => x.side === "Buy").length, spoofAsk = sp.filter(x => x.side === "Sell").length;
    const spreadTicks = m.tick ? Math.round((m.ask - m.bid) / m.tick) : 1;
    // scores 0..1
    const impulseUp = burst >= P.burstX && delta > 0.3 && move10 > 0;
    const impulseDn = burst >= P.burstX && delta < -0.3 && move10 < 0;
    let long = 0.30 * Math.max(0, (imb - 0.5) * 2) + 0.25 * Math.max(0, delta) + (impulseUp ? 0.2 : 0)
      + (iceBid ? 0.12 : 0) + (absBull ? 0.15 : 0) + (spoofAsk ? 0.08 : 0) - (spoofBid ? 0.15 : 0) - (iceAsk ? 0.1 : 0);
    let short = 0.30 * Math.max(0, (0.5 - imb) * 2) + 0.25 * Math.max(0, -delta) + (impulseDn ? 0.2 : 0)
      + (iceAsk ? 0.12 : 0) + (absBear ? 0.15 : 0) + (spoofBid ? 0.08 : 0) - (spoofAsk ? 0.15 : 0) - (iceBid ? 0.1 : 0);
    long = Math.max(0, Math.min(1, long)); short = Math.max(0, Math.min(1, short));
    return {
      sym, bid: m.bid, ask: m.ask, last: m.last, spreadTicks, imb: +imb.toFixed(2), delta: +delta.toFixed(2), burst: +burst.toFixed(1),
      move10: +move10.toFixed(3), iceBid, iceAsk, absBull, absBear, spoofBid, spoofAsk, long: +long.toFixed(2), short: +short.toFixed(2),
    };
  }

  // ---------------- orders ----------------
  const bx = (path, opts) => ev(`bx(${JSON.stringify(path)}, ${JSON.stringify(opts)})`);
  const specOf = (sym) => ev(`spec(${JSON.stringify(sym)})`);
  const alignP = (v, step, up) => ev(`align(${v}, ${JSON.stringify(String(step))}, ${up})`);
  const lid = (sym, tag) => ("ss" + tag + sym.slice(0, 10) + Date.now().toString(36) + Math.floor(Math.random() * 99)).slice(0, 36);
  // position mode of the account: one-way (positionIdx 0) or hedge (1 = long side, 2 = short side); found out on the first order
  const idxFor = (posSide) => ST.hedge ? (posSide === "Buy" ? 1 : 2) : 0;
  const idxErr = (e) => /position idx|position mode/i.test(String(e && e.message || e));
  async function withIdx(fn) {
    try { return await fn(); }
    catch (e) {
      if (!idxErr(e)) throw e;
      ST.hedge = !ST.hedge; lsSet("ssHedge", ST.hedge);
      log(`superscalp: position mode → ${ST.hedge ? "hedge" : "one-way"}`);
      return fn();
    }
  }
  async function limit(sym, side, price, qty, reduce, tag, postOnly = true) {
    const id = lid(sym, tag);
    const posSide = reduce ? (side === "Buy" ? "Sell" : "Buy") : side;   // a reduce order closes the opposite side
    await withIdx(() => bx("/v5/order/create", { method: "POST", auth: true, body: { category: "linear", symbol: sym, side, orderType: "Limit", qty: String(qty), price: String(price),
      timeInForce: postOnly ? "PostOnly" : "GTC", reduceOnly: !!reduce, orderLinkId: id, positionIdx: idxFor(posSide) } }));
    return id;
  }
  const setStop = (p, price) => withIdx(() => bx("/v5/position/trading-stop", { method: "POST", auth: true,
    body: { category: "linear", symbol: p.sym, stopLoss: String(price), slTriggerBy: "MarkPrice", tpslMode: "Full", positionIdx: idxFor(p.side) } }));
  const cancel = (sym, id) => bx("/v5/order/cancel", { method: "POST", auth: true, body: { category: "linear", symbol: sym, orderLinkId: id } }).catch(() => {});
  const amend = (sym, id, price) => bx("/v5/order/amend", { method: "POST", auth: true, body: { category: "linear", symbol: sym, orderLinkId: id, price: String(price) } });

  async function enter(sym, side, sig) {
    const sp = await specOf(sym);
    const lev = Math.min(P.leverage, Math.floor(sp.maxLev));
    const price = side === "Buy" ? sig.bid : sig.ask;                // join the best price: maker
    const qty = await alignP(P.margin * lev / price, sp.step, false);
    if (Number(qty) < sp.minQty || Number(qty) * price < sp.minNotional) { ST.err = `${sym}: замала маржа для мін. ордера`; return; }
    try { await bx("/v5/position/set-leverage", { method: "POST", auth: true, body: { category: "linear", symbol: sym, buyLeverage: String(lev), sellLeverage: String(lev) } }); } catch (e) { /* not modified */ }
    const id = await limit(sym, side, price, qty, false, "E");
    POSN[sym] = { sym, side, state: "entry", entryId: id, price, qty, at: Date.now(), sig, tick: sp.tick, step: sp.step };
    engineLog(`⚡⚡ ${sym}: ${side === "Buy" ? "лонг" : "шорт"} лімітом ${price} × ${qty} · стакан ${sig.imb} · дельта ${sig.delta} · сплеск ×${sig.burst}`
      + (sig.iceBid || sig.iceAsk ? " · айсберг" : "") + (sig.absBull || sig.absBear ? " · поглинання" : "") + (sig.spoofBid || sig.spoofAsk ? " · спуфінг" : ""), "gold-t");
  }

  async function onFilled(p, entryPx) {
    const long = p.side === "Buy";
    p.entry = entryPx; p.state = "open"; p.openedAt = Date.now();
    const tp = await alignP(entryPx * (1 + (long ? 1 : -1) * P.tpPct / 100), p.tick, long);
    const sl = await alignP(entryPx * (1 - (long ? 1 : -1) * P.slPct / 100), p.tick, !long);
    p.tp = Number(tp); p.sl = Number(sl);
    try { await setStop(p, sl); }
    catch (e) { engineLog(`⚡⚡ ${p.sym}: стоп не поставився: ${e.message}`, "down"); }
    try { p.tpId = await limit(p.sym, long ? "Sell" : "Buy", tp, p.qty, true, "T"); }
    catch (e) { p.tpId = await limit(p.sym, long ? "Sell" : "Buy", tp, p.qty, true, "T", false).catch(() => null); }
    engineLog(`⚡⚡ ${p.sym}: вхід виконано @ ${entryPx} · тейк лімітом ${tp} · стоп ${sl}`, long ? "up" : "down");
  }

  async function record(p, closed) {
    let pnl = 0, exitPx = null;
    try {
      const r = await bx("/v5/position/closed-pnl", { query: { category: "linear", symbol: p.sym, startTime: String(p.openedAt - 60000), limit: "20" }, auth: true });
      const rows = (r.list || []).filter(x => Number(x.createdTime) >= p.openedAt - 5000);
      pnl = rows.reduce((a, x) => a + Number(x.closedPnl || 0), 0);
      exitPx = rows.length ? Number(rows[0].avgExitPrice) : null;
    } catch (e) { /* keep 0 */ }
    const t = { sym: p.sym, side: p.side, entry: p.entry, exit: exitPx, pnl: +pnl.toFixed(4), roi: +(pnl / P.margin * 100).toFixed(2), how: closed,
      openedAt: p.openedAt, closedAt: Date.now(), holdSec: Math.round((Date.now() - p.openedAt) / 1000), rides: p.rides || 0,
      sig: p.sig && { imb: p.sig.imb, delta: p.sig.delta, burst: p.sig.burst, ice: p.sig.iceBid || p.sig.iceAsk, abs: p.sig.absBull || p.sig.absBear, spoof: !!(p.sig.spoofBid || p.sig.spoofAsk), score: Math.max(p.sig.long, p.sig.short) },
      cfg: { tpPct: P.tpPct, slPct: P.slPct, scoreIn: P.scoreIn, burstX: P.burstX, ride: P.ride } };
    ST.trades.push(t); ST.dayPnl += t.pnl; save();
    engineLog(`⚡⚡ ${p.sym}: закрито (${closed}) PnL ${t.pnl >= 0 ? "+" : ""}${t.pnl} USDT за ${t.holdSec} с`, t.pnl >= 0 ? "up" : "down");
    COOL[p.sym] = Date.now() + (t.pnl < 0 ? P.cooldownSec * 2 : P.cooldownSec) * 1000;
    delete POSN[p.sym];
  }

  // the breakout bot keeps away from our coins; its waiting orders on them are removed
  const W_SET = (list) => { try { ev(`window.__ssSyms = ${JSON.stringify(list)}`); } catch (e) { /* ignore */ } };
  async function freeCoins() {
    try {
      const n = await ev(`(async () => { let n = 0; for (const s of SETUPS.filter(x => x.state === "armed" && (window.__ssSyms || []).includes(x.symbol))) {
        await cancelAll(s); await cancelDip(s); SETUPS = SETUPS.filter(x => x !== s); n++; } if (n) saveSetups(); return n; })()`);
      if (n) engineLog(`⚡⚡ Суперскальпінг забрав свої монети: знято ${n} заявок пробою на них`, "mute");
    } catch (e) { /* next time */ }
  }

  // ---------------- the loop: entries every 0.5 s, our orders every 1.5 s ----------------
  let busy = false, lastPoll = 0;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const day = new Date().toISOString().slice(0, 10);
      if (ST.day !== day) { ST.day = day; ST.dayPnl = 0; ST.stoppedForDay = false; }
      if (P.on && !ST.stoppedForDay) {
        const eq = Number(ev("(window.__eq || 0)")) || 0;
        if (eq > 0 && ST.dayPnl <= -eq * P.dailyLossPct / 100) {
          ST.stoppedForDay = true;
          engineLog(`⚡⚡ Суперскальпінг: денний збиток ${ST.dayPnl.toFixed(2)} USDT ≥ ${P.dailyLossPct}% капіталу — нові входи до завтра вимкнено`, "down");
        }
      }
      // manage our entries / positions
      if (Object.keys(POSN).length && now - lastPoll >= 1500) {
        lastPoll = now;
        const [ordR, posR] = await Promise.all([
          bx("/v5/order/realtime", { query: { category: "linear", settleCoin: "USDT", limit: "50" }, auth: true }),
          bx("/v5/position/list", { query: { category: "linear", settleCoin: "USDT", limit: "200" }, auth: true }),
        ]);
        const live = new Map((ordR.list || []).map(o => [o.orderLinkId, o]));
        const pos = (posR.list || []).filter(x => Number(x.size) > 0);
        for (const p of Object.values(POSN)) {
          const ps = pos.find(x => x.symbol === p.sym && x.side === p.side);   // in hedge mode both sides can exist
          const sig = signals(p.sym);
          if (p.state === "entry") {
            if (ps) { await onFilled(p, Number(ps.avgPrice)); continue; }
            if (!live.has(p.entryId)) { delete POSN[p.sym]; continue; }     // cancelled / rejected (PostOnly crossed)
            if (now - p.at > P.entryWaitSec * 1000) { await cancel(p.sym, p.entryId); delete POSN[p.sym]; engineLog(`⚡⚡ ${p.sym}: вхід не виконався за ${P.entryWaitSec} с — знято`, "mute"); }
            continue;
          }
          if (!ps) { await record(p, live.has(p.tpId) ? "стоп" : "тейк"); if (p.tpId) await cancel(p.sym, p.tpId); continue; }
          const long = p.side === "Buy", px = sig ? sig.last : Number(ps.markPrice);
          const gone = (long ? px - p.entry : p.entry - px) / p.entry * 100;
          // ride the impulse: the take moves further and the stop goes to a small profit while the tape still pushes our way
          const push = sig && (long ? sig.delta > 0.3 && sig.burst >= P.burstX * 0.7 : sig.delta < -0.3 && sig.burst >= P.burstX * 0.7);
          if (P.ride && p.tpId && gone >= P.tpPct * 0.7 && push) {
            const ntp = await alignP(p.tp * (1 + (long ? 1 : -1) * P.tpPct / 200), p.tick, long);
            const be = await alignP(p.entry * (1 + (long ? 1 : -1) * 0.06 / 100), p.tick, long);
            try {
              await amend(p.sym, p.tpId, ntp); p.tp = Number(ntp); p.rides = (p.rides || 0) + 1;
              if (!p.beDone) { await setStop(p, be); p.beDone = true; p.sl = Number(be); }
              engineLog(`⚡⚡ ${p.sym}: імпульс триває — тейк → ${ntp}` + (p.beDone ? ", стоп у плюс" : ""), "up");
            } catch (e) { /* the take may have just filled */ }
          }
          // too long in the trade: pull the take to the best price (still a limit, maker) to get out
          if (now - p.openedAt > P.holdMaxSec * 1000 && sig && !p.pulled) {
            const best = long ? sig.ask : sig.bid;
            try { await amend(p.sym, p.tpId, best); p.tp = best; p.pulled = true; engineLog(`⚡⚡ ${p.sym}: тримаю довше ${P.holdMaxSec} с — тейк підтягнуто до ринку ${best} (лімітом)`, "mute"); } catch (e) { /* ignore */ }
          }
        }
      }
      // reserve our coins: the breakout bot does not use them while super scalping is on
      W_SET(P.on ? P.symbols : []);
      if (P.on && now - (ST.freedAt || 0) > 30000) { ST.freedAt = now; await freeCoins(); }
      // why there is no entry, per coin (shown on the page and given to the AI)
      for (const sym of P.symbols) {
        const s = signals(sym), m = M[sym] || {};
        const sc = s ? Math.max(s.long, s.short) : 0;
        m.peak = (m.peak || []).filter(x => now - x[0] < 600000); if (s) m.peak.push([now, sc]);
        m.why = !P.on ? "вимкнено" : ST.stoppedForDay ? "денний ліміт збитку" : !s ? "збираю стрічку (20 с)" : POSN[sym] ? "в угоді"
          : (COOL[sym] || 0) > now ? `пауза ${Math.round((COOL[sym] - now) / 1000)} с` : s.spreadTicks > 3 ? `широкий спред ${s.spreadTicks} тік.`
          : sc < P.scoreIn ? `сигнал ${sc.toFixed(2)} < ${P.scoreIn}` : Object.keys(POSN).length >= P.maxPositions ? "ліміт угод" : "входжу";
      }
      // new entries
      if (P.on && !ST.stoppedForDay && Object.keys(POSN).length < P.maxPositions) {
        const busySyms = new Set(JSON.parse(ev(`JSON.stringify(POS.map(p => p.symbol).concat(SETUPS.filter(s => s.state !== "armed").map(s => s.symbol)))`) || "[]"));
        for (const sym of P.symbols) if (busySyms.has(sym) && M[sym] && !POSN[sym]) M[sym].why = "позиція основного бота";
        const cands = P.symbols.map(signals).filter(Boolean)
          .filter(s => !POSN[s.sym] && !busySyms.has(s.sym) && (COOL[s.sym] || 0) < now && s.spreadTicks <= 3)
          .map(s => ({ s, side: s.long >= s.short ? "Buy" : "Sell", score: Math.max(s.long, s.short) }))
          .filter(c => c.score >= P.scoreIn).sort((a, b) => b.score - a.score);
        for (const c of cands) {
          if (Object.keys(POSN).length >= P.maxPositions) break;
          try { await enter(c.s.sym, c.side, c.s); } catch (e) { ST.err = `${c.s.sym}: ${e.message}`; COOL[c.s.sym] = now + 30000; }
        }
      }
    } catch (e) { ST.err = String(e && e.message || e); }
    finally { busy = false; }
  }
  setInterval(tick, 500);

  // ---------------- websocket ----------------
  function connect() {
    clearTimeout(reconnectT); clearInterval(pingT);
    const url = testWs || (env === "testnet" ? "wss://stream-testnet.bybit.com/v5/public/linear" : "wss://stream.bybit.com/v5/public/linear");
    try { ws = new WebSocket(url); } catch (e) { ST.err = "WebSocket: " + e.message; reconnectT = setTimeout(connect, 5000); return; }
    ws.on("open", () => {
      ST.wsUp = true; ST.err = "";
      const args = [];
      for (const s of P.symbols) args.push(`orderbook.50.${s}`, `publicTrade.${s}`);
      for (let i = 0; i < args.length; i += 10) ws.send(JSON.stringify({ op: "subscribe", args: args.slice(i, i + 10) }));
      pingT = setInterval(() => { try { ws.send(JSON.stringify({ op: "ping" })); } catch (e) { /* closed */ } }, 20000);
      log(`superscalp ws up: ${P.symbols.join(",")}`);
    });
    ws.on("message", (raw) => {
      ST.lastMsg = Date.now();
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m.topic) return;
      const [kind, a, b] = m.topic.split(".");
      if (kind === "orderbook") applyBook(b, m.data || {}, m.type === "snapshot");
      else if (kind === "publicTrade") applyTrades(a, m.data || []);
    });
    ws.on("close", () => { ST.wsUp = false; clearInterval(pingT); reconnectT = setTimeout(connect, 3000); });
    ws.on("error", (e) => { ST.err = "WebSocket: " + (e && e.message || e); });
  }
  function resubscribe() { try { ws && ws.close(); } catch (e) { /* reconnects */ } for (const k of Object.keys(M)) if (!P.symbols.includes(k)) delete M[k]; }
  connect();

  // ---------------- control + views ----------------
  const NUM = { margin: [1, 100000], leverage: [1, 50], tpPct: [0.06, 2], slPct: [0.1, 3], scoreIn: [0.3, 0.95], bandPct: [0.05, 1], burstX: [1.2, 10],
    wallX: [2, 30], spoofSec: [1, 20], icebergX: [1.5, 20], entryWaitSec: [2, 60], holdMaxSec: [30, 3600], maxPositions: [1, 10], cooldownSec: [0, 3600], dailyLossPct: [0.5, 20] };
  function setParams(o, caps = {}) {
    const changed = [];
    for (const [k, v] of Object.entries(o || {})) {
      if (NUM[k]) {
        let n = Number(v); if (!Number.isFinite(n)) continue;
        let hi = NUM[k][1];
        if (k === "margin" && caps.margin) hi = Math.min(hi, caps.margin);
        if (k === "leverage" && caps.leverage) hi = Math.min(hi, caps.leverage);
        n = Math.max(NUM[k][0], Math.min(hi, n));
        if (["maxPositions", "leverage", "entryWaitSec", "holdMaxSec", "cooldownSec", "spoofSec"].includes(k)) n = Math.round(n);
        if (P[k] !== n) { changed.push(`${k} ${P[k]}→${n}`); P[k] = n; }
      } else if (["ride", "useIceberg", "useAbsorption", "useSpoof", "on"].includes(k) && typeof v === "boolean") {
        if (P[k] !== v) { changed.push(`${k} ${P[k]}→${v}`); P[k] = v; }
      } else if (k === "symbols" && Array.isArray(v)) {
        const list = [...new Set(v.map(x => String(x).toUpperCase()).filter(x => /^[A-Z0-9]{2,30}USDT$/.test(x)))].slice(0, 12);
        if (list.length && list.join() !== P.symbols.join()) { changed.push(`монети ${list.join(",")}`); P.symbols = list; resubscribe(); }
      }
    }
    save();
    return changed;
  }
  function setOn(on) { P.on = !!on; save(); engineLog(on ? `⚡⚡ Суперскальпінг увімкнено: ${P.symbols.join(", ")} · тейк ${P.tpPct}% лімітом · стоп ${P.slPct}%` : "⚡⚡ Суперскальпінг вимкнено (відкриті угоди доведе до кінця)", on ? "up" : "mute"); }
  function stats() {
    const t = ST.trades, w = t.filter(x => x.pnl > 0);
    const day = t.filter(x => x.closedAt >= Date.now() - 86400e3);
    return { n: t.length, win: t.length ? Math.round(w.length / t.length * 100) : null, pnl: +t.reduce((a, x) => a + x.pnl, 0).toFixed(4),
      day: day.length, dayPnl: +day.reduce((a, x) => a + x.pnl, 0).toFixed(4), avgHold: t.length ? Math.round(t.reduce((a, x) => a + x.holdSec, 0) / t.length) : null };
  }
  function view() {
    return { params: P, ws: ST.wsUp && Date.now() - ST.lastMsg < 15000, err: ST.err, stoppedForDay: ST.stoppedForDay, stats: stats(),
      live: P.symbols.map(sym => Object.assign({ sym }, signals(sym) || {}, { why: (M[sym] || {}).why || "підключаюсь", peak10: +Math.max(0, ...((M[sym] || {}).peak || []).map(x => x[1])).toFixed(2) })), open: Object.values(POSN).map(p => ({ sym: p.sym, side: p.side, state: p.state, entry: p.entry || p.price, tp: p.tp || null, sl: p.sl || null, rides: p.rides || 0, sec: Math.round((Date.now() - (p.openedAt || p.at)) / 1000) })),
      trades: ST.trades.slice(-15).reverse() };
  }
  function aiView() {
    // what the AI needs: parameters, results, live signals and the last trades with the signals they were taken on
    const by = (f) => { const g = {}; for (const t of ST.trades.slice(-300)) { const k = f(t); if (k == null) continue; (g[k] = g[k] || []).push(t); }
      return Object.entries(g).map(([k, a]) => ({ value: k, n: a.length, win: Math.round(a.filter(x => x.pnl > 0).length / a.length * 100), pnl: +a.reduce((s, x) => s + x.pnl, 0).toFixed(4) })); };
    return { params: P, stats: stats(), live: P.symbols.map(sym => Object.assign({ sym }, signals(sym) || {}, { why: (M[sym] || {}).why || "", peakScore10min: +Math.max(0, ...((M[sym] || {}).peak || []).map(x => x[1])).toFixed(2) })),
      bySymbol: by(t => t.sym), bySignal: [].concat(by(t => t.sig && t.sig.ice ? "iceberg" : null), by(t => t.sig && t.sig.abs ? "absorption" : null), by(t => t.sig && t.sig.spoof ? "spoof" : null)),
      byTp: by(t => t.cfg && t.cfg.tpPct), last: ST.trades.slice(-20) };
  }
  return { view, aiView, setParams, setOn, params: P, signals, _test: { M, POSN, applyBook, applyTrades } };
}

module.exports = { create, DEFAULTS };
