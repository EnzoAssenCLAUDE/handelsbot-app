// Handelsscherm: alleen lezen. Geen Bitvavo-sleutels, geen knoppen die handelen.
// Markt (koers, candles, orderboek, transacties): openbare Bitvavo-data, live via websocket.
// Bot (saldo, besluiten, logboek): branch `logboek` van de privé-repo, met een leessleutel die alleen op dit toestel staat.
import * as core from "./core.js?v=6";
import * as mk from "./market.js?v=6";
import { createChart, CrosshairMode, LineStyle } from "./vendor/lightweight-charts.mjs?v=6";

const $ = (id) => document.getElementById(id);
const BRANCH = "logboek";
const WORKFLOW = "bot-dagelijks.yml";
const KEY = { cfg: "meekijk.cfg", thema: "meekijk.thema", iv: "meekijk.interval", tab: "meekijk.tab", lagen: "meekijk.lagen" };
const LOG_EVERY = 5 * 60_000;
const DAILY_EVERY = 10 * 60_000;
const DAY = 86_400_000;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* niets */ } },
};

const st = {
  cfg: store.get(KEY.cfg), log: null, stop: null, runs: null, vars: null, logAt: null, logErr: null,
  daily: null, ticker: {}, last: null, trades: [], tradeIds: new Set(), book: null,
  iv: mk.INTERVALS[store.get(KEY.iv)] ? store.get(KEY.iv) : "1h", candles: [],
  lagen: { sma: true, trades: true, vol: true, ...(store.get(KEY.lagen) || {}) },
  tab: store.get(KEY.tab) || "boek", shown: 30,
};

// ---------------- opmaak ----------------
const tz = { timeZone: "Europe/Amsterdam" };
const nl0 = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });
const prijs = (x) => (Number.isFinite(x) ? nl0.format(x) : "–");
const btc = (x, d) => (Number.isFinite(x) ? x.toFixed(d ?? (x > 0 && x < 0.001 ? 8 : 5)).replace(".", ",") : "–");
const tijd = (ms) => new Date(ms).toLocaleTimeString("nl-NL", { ...tz, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const datumTijd = (d) => new Date(d).toLocaleString("nl-NL", { ...tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dag = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("nl-NL", { ...tz, day: "numeric", month: "long" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const teken = (x) => (x >= 0 ? "+" : "−");
const cls = (x) => (x >= 0 ? "op" : "neer");

// Grafiektijden: de bibliotheek rekent in UTC; de labels zetten we om naar Nederlandse tijd.
// (Verschuiven van de tijden zelf zou bij de wintertijd twee candles op hetzelfde uur zetten.)
const T = (ms) => Math.floor(ms / 1000);
const fmt = (o) => new Intl.DateTimeFormat("nl-NL", { ...tz, ...o });
const F = { jaar: fmt({ year: "numeric" }), maand: fmt({ month: "short" }), dag: fmt({ day: "numeric", month: "short" }),
  uur: fmt({ hour: "2-digit", minute: "2-digit" }), sec: fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  vol: fmt({ weekday: "short", day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }),
  datum: fmt({ weekday: "short", day: "numeric", month: "short", year: "2-digit" }) };
const clean = (x) => x.replace(".", "");
function tickLabel(time, type) {
  const d = new Date(time * 1000);
  return [() => F.jaar.format(d), () => clean(F.maand.format(d)), () => clean(F.dag.format(d)),
    () => F.uur.format(d), () => F.sec.format(d)][type]?.() ?? "";
}
const crossLabel = (time) => (st.iv === "1d" || st.iv === "1W" ? F.datum : F.vol).format(new Date(time * 1000));

// ---------------- thema ----------------
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function alpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
function effectiveTheme() {
  return document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}
$("thema").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set(KEY.thema, next);
  try { localStorage.setItem(KEY.thema, next); } catch { /* niets */ }
  applyChartTheme();
});
matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", applyChartTheme);

// ---------------- grafiek ----------------
const chart = createChart($("grafiek"), {
  autoSize: true,
  crosshair: { mode: CrosshairMode.Normal },
  timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 8, minBarSpacing: 1.5,
    tickMarkFormatter: (t, type) => tickLabel(t, type) },
  rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.22 } },
  localization: { locale: "nl-NL", priceFormatter: (p) => prijs(p), timeFormatter: (t) => crossLabel(t) },
  layout: { attributionLogo: false },
});
const candleS = chart.addCandlestickSeries({ borderVisible: false, priceLineStyle: LineStyle.Dotted });
const volS = chart.addHistogramSeries({ priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
chart.priceScale("").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
const smaS = chart.addLineSeries({ lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
let grensLine = null;

function applyChartTheme() {
  const lijn = css("--lijn"), sterk = css("--lijn-sterk");
  chart.applyOptions({
    layout: { background: { type: "solid", color: css("--paneel") }, textColor: css("--zacht"), fontSize: 11,
      fontFamily: "Lato, 'Helvetica Neue', Arial, sans-serif", attributionLogo: false },
    grid: { vertLines: { color: lijn }, horzLines: { color: lijn } },
    rightPriceScale: { borderColor: lijn }, timeScale: { borderColor: lijn },
    crosshair: { vertLine: { color: sterk, labelBackgroundColor: css("--paneel-2") },
      horzLine: { color: sterk, labelBackgroundColor: css("--paneel-2") } },
  });
  const op = css("--op"), neer = css("--neer");
  candleS.applyOptions({ upColor: op, downColor: neer, wickUpColor: op, wickDownColor: neer, priceLineColor: css("--goud") });
  smaS.applyOptions({ color: css("--goud") });
  setChartData(false);
}

const bar = (c) => ({ time: T(c.t), open: c.open, high: c.high, low: c.low, close: c.close });
const volBar = (c) => ({ time: T(c.t), value: c.volume, color: alpha(c.close >= c.open ? css("--op") : css("--neer"), 0.38) });

function setChartData(resetView) {
  const cs = st.candles;
  candleS.setData(cs.map(bar));
  volS.setData(st.lagen.vol ? cs.map(volBar) : []);
  if (st.iv === "1d" && st.lagen.sma) {
    const sma = core.smaSeries(cs.map((c) => c.close));
    smaS.setData(cs.map((c, i) => (sma[i] == null ? null : { time: T(c.t), value: sma[i] })).filter(Boolean));
  } else smaS.setData([]);
  updateGrens();
  updateMarkers();
  if (resetView && cs.length) {
    const show = { "1m": 120, "5m": 144, "15m": 160, "1h": 168, "4h": 180, "1d": 365, "1W": 260 }[st.iv] || 150;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, cs.length - show), to: cs.length + 4 });
  }
  legend();
}

function updateGrens() {
  const g = grens();
  if (grensLine) { candleS.removePriceLine(grensLine); grensLine = null; }
  if (g && st.lagen.sma) {
    grensLine = candleS.createPriceLine({ price: g, color: css("--goud"), lineWidth: 1, lineStyle: LineStyle.Dashed,
      axisLabelVisible: true, title: "bot-grens" });
  }
}

function botOrders() {
  if (!st.log) return [];
  const s = core.summary(st.log);
  return st.log.filter((e) => e.type === "order" && !e.test && e.mode === s.mode);
}

function updateMarkers() {
  if (!st.lagen.trades || !st.candles.length) { candleS.setMarkers([]); return; }
  const cs = st.candles, op = css("--op"), neer = css("--neer");
  const marks = [];
  for (const o of botOrders()) {
    const ms = new Date(o.at).getTime();
    let lo = 0, hi = cs.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cs[mid].t <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx < 0) continue;
    const buy = o.side === "buy";
    marks.push({ time: T(cs[idx].t), position: buy ? "belowBar" : "aboveBar", color: buy ? op : neer,
      shape: buy ? "arrowUp" : "arrowDown", text: buy ? "koop" : "verkoop" });
  }
  marks.sort((a, b) => a.time - b.time);
  candleS.setMarkers(marks);
}

function legend(param) {
  const cs = st.candles;
  if (!cs.length) { $("ohlc").innerHTML = ""; return; }
  let c = cs[cs.length - 1];
  if (param?.time) {
    const d = param.seriesData.get(candleS);
    if (d) c = { open: d.open, high: d.high, low: d.low, close: d.close };
  }
  const ch = (c.close - c.open) / c.open;
  const sma = param?.time ? param.seriesData.get(smaS)?.value : null;
  $("ohlc").innerHTML = `<span>O <b>${prijs(c.open)}</b></span><span>H <b>${prijs(c.high)}</b></span>`
    + `<span>L <b>${prijs(c.low)}</b></span><span>S <b class="${cls(ch)}">${prijs(c.close)}</b></span>`
    + `<span class="${cls(ch)}">${teken(ch)}${core.pct(Math.abs(ch), 2)}</span>`
    + (sma ? `<span class="sma">gem. 200d ${prijs(sma)}</span>` : "");
}
chart.subscribeCrosshairMove(legend);

let ivReq = 0;
async function loadInterval(iv, resetView = true) {
  st.iv = iv;
  store.set(KEY.iv, iv);
  feed.setInterval(iv);
  document.querySelectorAll("#intervallen button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.iv === iv)));
  const req = ++ivReq;
  try {
    const cs = (await mk.fetchCandles(iv, 1000)).filter((c, i, a) => i === 0 || c.t > a[i - 1].t);
    if (req !== ivReq) return;
    st.candles = cs;
    if (iv === "1d") st.daily = cs;
    setChartData(resetView);
  } catch (e) {
    if (req === ivReq) $("ohlc").textContent = "Koersdata niet geladen. Geen internet?";
  }
}

function onCandle(c, iv) {
  if (iv !== st.iv || !st.candles.length) return;
  const cs = st.candles, last = cs[cs.length - 1];
  if (c.t < last.t) return;
  if (c.t === last.t) cs[cs.length - 1] = c; else cs.push(c);
  try {
    candleS.update(bar(c));
    if (st.lagen.vol) volS.update(volBar(c));
  } catch { /* oudere update: negeren */ }
  legend();
}

$("intervallen").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-iv]");
  if (b && b.dataset.iv !== st.iv) loadInterval(b.dataset.iv);
});
for (const [id, key] of [["t-sma", "sma"], ["t-trades", "trades"], ["t-vol", "vol"]]) {
  const b = $(id);
  b.setAttribute("aria-pressed", String(st.lagen[key]));
  b.addEventListener("click", () => {
    st.lagen[key] = !st.lagen[key];
    b.setAttribute("aria-pressed", String(st.lagen[key]));
    store.set(KEY.lagen, st.lagen);
    setChartData(false);
  });
}

// ---------------- dagkoersen: bot-grens en voorlopig signaal ----------------
async function loadDaily() {
  try { st.daily = await mk.fetchCandles("1d", 400); } catch { /* volgende keer */ }
  updateGrens();
  renderStats();
  renderBot();
}
function closedDaily() {
  const now = Date.now();
  return (st.daily || []).filter((c) => c.t + DAY <= now).map((c) => c.close);
}
const grens = () => core.threshold(closedDaily());
function livePrice() { return st.book?.bids?.[0] ? +st.book.bids[0][0] : st.ticker.bid || st.last || null; }

// ---------------- ticker, transacties, orderboek ----------------
let raf = 0;
let botAt = 0;
function schedule() {
  if (!raf) raf = requestAnimationFrame(() => {
    raf = 0; renderTicker(); renderTrades(); renderBook(); renderStats();
    if (Date.now() - botAt > 1500) renderBot(); // waarde en signaal bewegen mee met de koers
  });
}

function onTicker(t) {
  for (const k of ["open", "high", "low", "last", "volume", "volumeQuote", "bid", "ask"]) if (t[k] != null) st.ticker[k] = +t[k];
  if (st.last == null && st.ticker.last) setLast(st.ticker.last);
  schedule();
}

let flitsTimer;
function setLast(p) {
  const el = $("prijs");
  if (st.last != null && p !== st.last) {
    el.classList.remove("flits-op", "flits-neer");
    void el.offsetWidth;
    el.classList.add(p > st.last ? "flits-op" : "flits-neer");
    clearTimeout(flitsTimer);
    flitsTimer = setTimeout(() => el.classList.remove("flits-op", "flits-neer"), 900);
  }
  st.last = p;
}

function onTrade(x) {
  if (!x?.id || st.tradeIds.has(x.id)) return;
  st.tradeIds.add(x.id);
  const t = { id: x.id, price: +x.price, amount: +x.amount, side: x.side, ts: +x.timestamp, nieuw: true };
  st.trades.push(t);
  st.trades.sort((a, b) => b.ts - a.ts);
  if (st.trades.length > 60) st.trades.length = 60;
  if (st.tradeIds.size > 500) st.tradeIds = new Set(st.trades.map((y) => y.id));
  if (st.trades[0] === t) setLast(t.price);
  schedule();
}

function onBook(b) { st.book = b; schedule(); }

function renderTicker() {
  const t = st.ticker;
  const p = st.last ?? t.last;
  $("prijs").textContent = p ? prijs(p) : "–";
  if (p && t.open) {
    const ch = (p - t.open) / t.open;
    const chip = $("wijziging");
    chip.textContent = `${teken(ch)}${core.pct(Math.abs(ch), 2)} 24u`;
    chip.className = `chip ${cls(ch)}`;
  }
  if (p) document.title = `${prijs(p)} · BTC-EUR`;
}

function renderStats() {
  const t = st.ticker;
  $("s-hoog").textContent = prijs(t.high);
  $("s-laag").textContent = prijs(t.low);
  $("s-vol").textContent = t.volume ? `${btc(t.volume, 0)} BTC · €${(t.volumeQuote / 1e6).toFixed(1).replace(".", ",")} mln` : "–";
  const bid = st.book?.bids?.[0]?.[0] ?? t.bid, ask = st.book?.asks?.[0]?.[0] ?? t.ask;
  $("s-spread").textContent = bid && ask ? `${prijs(+bid)} / ${prijs(+ask)}` : "–";
  const g = grens(), p = livePrice();
  $("s-grens").innerHTML = g ? `${prijs(g)}${p ? ` <span class="${cls(p - g)}">(${teken(p - g)}${core.pct(Math.abs(p - g) / g)})</span>` : ""}` : "–";
}

function renderTrades() {
  const el = $("trades");
  if (!st.trades.length) { el.innerHTML = `<div class="leeg">Transacties laden…</div>`; return; }
  el.innerHTML = st.trades.slice(0, 40).map((t) =>
    `<div class="rij ${t.side === "buy" ? "op" : "neer"}${t.nieuw ? " nieuw" : ""}"><span>${prijs(t.price)}</span><span>${btc(t.amount)}</span><span>${tijd(t.ts)}</span></div>`).join("");
  st.trades.forEach((t) => { t.nieuw = false; });
}

function renderBook() {
  const b = st.book;
  if (!b?.asks?.length || !b?.bids?.length) { $("asks").innerHTML = `<div class="leeg">Orderboek laden…</div>`; return; }
  const n = innerWidth < 1024 ? 10 : 12;
  const side = (rows) => { let cum = 0; return rows.slice(0, n).map(([p, a]) => { cum += +p * +a; return { p: +p, a: +a, cum }; }); };
  const asks = side(b.asks), bids = side(b.bids);
  const max = Math.max(asks[asks.length - 1].cum, bids[bids.length - 1].cum);
  const row = (r) => `<div class="rij" style="--d:${((r.cum / max) * 100).toFixed(1)}%"><span>${prijs(r.p)}</span><span>${btc(r.a)}</span><span>${prijs(r.cum)}</span></div>`;
  $("asks").innerHTML = asks.slice().reverse().map(row).join("");
  $("bids").innerHTML = bids.map(row).join("");
  const spread = asks[0].p - bids[0].p, mid = (asks[0].p + bids[0].p) / 2;
  $("midden").innerHTML = `<span>${prijs(st.last ?? mid)}</span><small>spread €${prijs(spread)} · ${core.pct(spread / mid, 3)}</small>`;
}

// ---------------- verbinding ----------------
const feed = new mk.Feed({
  onTicker, onTrade, onBook, onCandle,
  onStatus: (s) => {
    const el = $("verbinding");
    el.className = `verbinding ${s}`;
    el.querySelector("span").textContent = s === "live" ? "Live" : "Vertraagd";
    el.title = s === "live" ? "Live verbonden met Bitvavo" : "Websocket niet bereikbaar: elke paar seconden opnieuw opgehaald";
  },
});
// Zonder websocket na 6 s: meld "vertraagd" (de gewone API vult dan aan).
setTimeout(() => { if (!feed.live && $("verbinding").className === "verbinding") feed.h.onStatus("traag"); }, 6000);

// ---------------- bot (logboek) ----------------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function gh(path, raw = false) {
  const r = await fetch(`https://api.github.com/repos/${st.cfg.repo}${path ? "/" + path : ""}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${st.cfg.token}`, "X-GitHub-Api-Version": "2022-11-28",
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json" },
  });
  if (!r.ok) throw new HttpError(r.status, `GitHub ${r.status}`);
  return raw ? r.text() : r.json();
}
const optional = (p) => p.catch((e) => (e instanceof HttpError && (e.status === 403 || e.status === 404) ? null : Promise.reject(e)));

let logBusy = false;
async function loadLog() {
  if (!st.cfg?.token || logBusy) return;
  logBusy = true;
  try {
    const [text, stop, runs, vars] = await Promise.all([
      gh(`contents/logboek.jsonl?ref=${BRANCH}`, true).catch((e) => { if (e.status === 404 && st.log !== null) throw e; if (e.status === 404) return ""; throw e; }),
      gh(`contents/STOP?ref=${BRANCH}`, true).then(() => true, (e) => (e.status === 404 ? false : null)),
      optional(gh(`actions/workflows/${WORKFLOW}/runs?per_page=3`)),
      optional(gh("actions/variables?per_page=30")),
    ]);
    st.log = core.parseLog(text);
    st.stop = stop;
    st.runs = runs?.workflow_runs ?? null;
    st.vars = vars?.variables ? Object.fromEntries(vars.variables.map((v) => [v.name, v.value])) : null;
    st.logAt = new Date();
    st.logErr = null;
  } catch (e) {
    st.logErr = e.status === 401 ? "De leessleutel werkt niet (meer). Tik op Bot koppelen en vul een nieuwe in."
      : e.status === 404 ? "De sleutel heeft geen toegang tot de repository. Kies bij de sleutel 'Only select repositories' en vink de bot aan."
      : "Logboek niet opgehaald (geen internet?). De app probeert het zo opnieuw.";
  } finally {
    logBusy = false;
  }
  renderBot();
  renderLogboek();
  updateMarkers();
}

const WORDS = { buy: "kopen", sell: "verkopen", niets: "niets doen", noodstop: "noodstop" };
const wordFor = (a) => WORDS[a] || a || "–";

function nextRun(now = new Date()) {
  const n = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 17));
  if (n <= now) n.setUTCDate(n.getUTCDate() + 1);
  return n;
}
function over(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `over ${Math.floor(m / 60)}u ${m % 60}m` : `over ${m}m`;
}

function botState() {
  const s = st.log ? core.summary(st.log) : null;
  const pos = st.log ? core.position(st.log) : null;
  const p = livePrice();
  const stopped = st.stop === true || st.vars?.BOT_STOP === "1";
  const closes = closedDaily();
  const prov = p ? core.provisional(closes, p) : null;
  return { s, pos, p, stopped, prov, g: core.threshold(closes) };
}

function renderBot() {
  botAt = Date.now();
  const { s, pos, p, stopped, prov, g } = botState();
  const has = !!s?.decisions;
  const valNow = has && pos && p ? pos.eur + pos.qty * p : has ? s.value : null;
  const holdNow = has ? (p ? s.hold_qty * p : s.hold) : null;
  const inBtc = pos && p ? pos.qty * p >= 5 : null;

  // strook
  const pil = $("b-stand");
  pil.className = "stand-pil" + (has && s.mode === "live" && !stopped ? " live" : "");
  pil.textContent = !st.cfg ? "Bot koppelen" : stopped ? "Noodstop" : !st.log ? "Bot laden" : !has ? "Wacht op 1e run"
    : s.mode === "live" ? "Bot · live" : "Bot · paper";
  pil.onclick = () => (st.cfg ? selectTab("bot") : openSetup());
  $("b-waarde").textContent = valNow != null ? core.eur(valNow) : "–";
  const res = valNow != null ? valNow - s.start : null;
  $("b-resultaat").innerHTML = res != null ? `<span class="${cls(res)}">${teken(res)}${core.eur(Math.abs(res))}</span>` : "–";
  const vs = valNow != null ? valNow - holdNow : null;
  $("b-hold").innerHTML = vs != null ? `<span class="${cls(vs)}">${teken(vs)}${core.eur(Math.abs(vs))}</span>` : "–";
  let zin = "–";
  if (stopped) zin = "niets (noodstop)";
  else if (prov) {
    if (inBtc === true) zin = prov.above ? "bitcoin houden" : "alles verkopen";
    else if (inBtc === false) zin = prov.above ? "bitcoin kopen" : "in euro blijven";
    else zin = prov.above ? "in bitcoin" : "in euro";
  }
  $("b-signaal").innerHTML = prov && !stopped ? `<span class="${prov.above ? "op" : "neer"}">${zin}</span>` : zin;
  const nr = nextRun();
  $("b-volgende").textContent = `${nr.toLocaleTimeString("nl-NL", { ...tz, hour: "2-digit", minute: "2-digit" })} · ${over(nr - Date.now())}`;

  renderMeldingen(s, stopped);

  // paneel
  const el = $("botinhoud");
  if (!st.cfg) {
    el.innerHTML = `<p class="botzin">Koppel je bot om saldo, trades en logboek te zien.</p>
      <p class="botuitleg">De koers en het orderboek werken al zonder koppeling. Voor je bot is een GitHub-sleutel nodig die alleen mag lezen.</p>
      <p class="koppel"><button class="knop" id="koppel">Bot koppelen</button></p>`;
    $("koppel").onclick = openSetup;
  } else if (!has) {
    el.innerHTML = `<p class="botzin">${st.logErr ? esc(st.logErr) : st.log ? "Nog geen besluit van de bot in het logboek." : "Logboek laden…"}</p>
      <p class="botuitleg">Na de eerste nachtrun (${esc(nr.toLocaleString("nl-NL", { ...tz, weekday: "long", hour: "2-digit", minute: "2-digit" }))}) staat hier de stand.</p>`;
  } else {
    const sinds = dag(s.since);
    const dicht = new Date(nr.getTime() - 17 * 60_000); // de dagkaars sluit om 00:00 UTC, 17 minuten voor de run
    const slot = dicht.toLocaleTimeString("nl-NL", { ...tz, hour: "2-digit", minute: "2-digit" });
    el.innerHTML = `<div class="botkaarten">
      <div><b>${core.eur(valNow)}</b><span>geschatte waarde nu${pos ? `: ${btc(pos.qty, 8)} BTC en ${core.eur(pos.eur)}` : ""}</span></div>
      <div><b class="${cls(res)}">${teken(res)}${core.eur(Math.abs(res))}</b><span>resultaat sinds ${esc(sinds)} (start ${core.eur(s.start, 0)})</span></div>
      <div><b class="${cls(vs)}">${teken(vs)}${core.eur(Math.abs(vs))}</b><span>verschil met bitcoin vasthouden (${core.eur(holdNow)})</span></div>
      <div><b>${s.orders}</b><span>orders, samen ${core.eur(s.fees)} kosten</span></div></div>
      <p class="botzin">${stopped ? "De noodstop staat aan: vannacht doet de bot niets."
        : prov && g ? `Sluit bitcoin om ${esc(slot)} boven ${core.eur(g, 0)}, dan wil de bot in bitcoin zitten. Nu: ${core.eur(p, 0)}, dus <span class="${prov.above ? "op" : "neer"}">${esc(zin)}</span>.`
        : "Koersdata laden…"}</p>
      <p class="botuitleg">Dit is een voorlopige stand. De bot kijkt alleen naar de slotkoers om middernacht (UTC), en die kan tot dan nog alle kanten op.
        Laatste besluit: <b>${esc(wordFor(s.action))}</b>${s.reason ? `, ${esc(s.reason)}` : ""} (${esc(datumTijd(s.last_at))}).
        Volgende: ${esc(nr.toLocaleString("nl-NL", { ...tz, weekday: "long", hour: "2-digit", minute: "2-digit" }))}, GitHub start soms later.</p>
      ${st.logErr ? `<p class="botuitleg">${esc(st.logErr)}</p>` : ""}`;
  }
  $("bijgewerkt").textContent = st.logAt ? `Logboek opgehaald ${datumTijd(st.logAt)}, ververst elke 5 minuten.` : "";
}

function renderMeldingen(s, stopped) {
  const m = [];
  if (stopped) {
    m.push(`<div class="melding stop"><b>Noodstop actief.</b> De bot doet niets ${st.stop === true
      ? "tot het bestand STOP op de branch logboek is verwijderd" : "zolang de variabele BOT_STOP op 1 staat"}.</div>`);
  }
  const run = st.runs?.[0];
  if (run && run.status === "completed" && run.conclusion !== "success") {
    m.push(`<div class="melding fout"><b>De laatste nachtrun is mislukt</b> (${datumTijd(run.created_at)}).
      <a href="${esc(run.html_url)}" target="_blank" rel="noopener">Bekijk de run</a>. GitHub mailt je hier ook over.</div>`);
  }
  if (s?.decisions && Date.now() - new Date(s.last_at) > 36 * 3_600_000) {
    m.push(`<div class="melding fout"><b>Al meer dan anderhalve dag geen besluit.</b> Laatste: ${datumTijd(s.last_at)}. Controleer of de nachtrun nog draait.</div>`);
  }
  if (st.vars?.BOT_MODE && s?.mode && st.vars.BOT_MODE !== s.mode) {
    m.push(`<div class="melding">De bot staat ingesteld op <b>${esc(st.vars.BOT_MODE)}</b>, de laatste run was <b>${esc(s.mode)}</b>. De volgende nachtrun draait als ${esc(st.vars.BOT_MODE)}.</div>`);
  }
  if (st.logErr && st.cfg) m.push(`<div class="melding fout">${esc(st.logErr)}</div>`);
  $("meldingen").innerHTML = m.join("");
}

function what(x) {
  if (x.type === "test") return x.step ? `Test-order: ${x.step}` : "Test-order";
  if (x.type === "stopped") return "Gestopt";
  if (x.type === "order") return (x.side === "buy" ? "Order: koop" : "Order: verkoop") + (x.test ? " (test)" : "");
  if (x.type === "decision") return `Besluit: ${wordFor(x.action)}`;
  return x.type || "–";
}
function amount(x) {
  if (x.type === "decision") { const v = x.value_after_eur ?? x.value_eur; return typeof v === "number" ? `waarde ${core.eur(v)}` : ""; }
  if (typeof x.eur === "number") return core.eur(x.eur);
  if (x.type === "test" && typeof x.kosten_eur === "number") return `kosten ${core.eur(x.kosten_eur)}`;
  return "";
}
function renderLogboek() {
  const el = $("logboek");
  if (!st.cfg) { el.innerHTML = `<li><span class="reden">Koppel je bot om het logboek te zien.</span></li>`; return; }
  const all = (st.log || []).slice().reverse();
  if (!all.length) { el.innerHTML = `<li><span class="reden">${st.log ? "Nog geen regels in het logboek." : "Laden…"}</span></li>`; return; }
  el.innerHTML = all.slice(0, st.shown).map((x) => `<li>
    <span class="wat">${esc(what(x))}<span class="stand ${x.mode === "live" ? "live" : ""}">${esc(x.mode || "")}</span></span>
    <span class="bedrag">${esc(amount(x))}</span><span class="tijd">${esc(datumTijd(x.at))}</span><span></span>
    ${x.reason ? `<span class="reden">${esc(x.reason)}</span>` : ""}</li>`).join("")
    + (all.length > st.shown ? `<li style="display:block;border:0"><button class="meer" id="meer">Toon meer (${all.length - st.shown})</button></li>` : "");
  $("meer")?.addEventListener("click", () => { st.shown += 50; renderLogboek(); });
}

// ---------------- tabs (telefoon) ----------------
function selectTab(name) {
  st.tab = name;
  store.set(KEY.tab, name);
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll(".paneel[data-paneel]").forEach((p) => p.classList.toggle("actief", p.dataset.paneel === name));
}
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) selectTab(b.dataset.tab);
});

// ---------------- koppelen ----------------
const dlg = $("instellen");
function openSetup(error) {
  $("repo").value = st.cfg?.repo || "";
  $("token").value = "";
  $("token").placeholder = st.cfg?.token ? "laat leeg om de huidige te houden" : "github_pat_…";
  $("formfout").hidden = !error;
  $("formfout").textContent = error || "";
  $("vergeet").hidden = !st.cfg;
  if (!dlg.open) { try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); } }
}
$("naarinstellen").addEventListener("click", () => openSetup());
$("sluit").addEventListener("click", () => dlg.close());
$("vergeet").addEventListener("click", () => { store.del(KEY.cfg); st.cfg = null; st.log = null; dlg.close(); renderBot(); renderLogboek(); updateMarkers(); });
$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const fout = (t) => { $("formfout").hidden = false; $("formfout").textContent = t; };
  const repo = $("repo").value.replace(/\s+/g, "").replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const token = $("token").value.replace(/\s+/g, "") || st.cfg?.token || "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return fout("Vul de repository in als eigenaar/naam, bijvoorbeeld iemand/mijn-repo.");
  if (!token) return fout("Plak je leessleutel (begint met github_pat_).");
  const old = st.cfg;
  st.cfg = { repo, token };
  $("opslaan").disabled = true;
  try {
    await gh("");
  } catch (e) {
    st.cfg = old;
    $("opslaan").disabled = false;
    return fout(e.status === 401 ? "GitHub weigert deze sleutel. Kopieer hem opnieuw, helemaal."
      : e.status === 404 ? "GitHub geeft deze sleutel geen toegang tot deze repository. Kies bij de sleutel 'Only select repositories', vink de repository aan en zet Contents op Read-only."
      : `Controle mislukt (${e.message}). Probeer het opnieuw.`);
  }
  $("opslaan").disabled = false;
  if (!store.set(KEY.cfg, st.cfg)) fout("Let op: deze browser bewaart niets (privévenster?). De app vraagt de sleutel straks opnieuw.");
  else dlg.close();
  st.log = null;
  renderBot();
  loadLog();
  selectTab("bot");
});

// ---------------- start en verversen ----------------
let timers = [];
function startAll(reload) {
  feed.start();
  if (reload) { loadInterval(st.iv, false); loadDaily(); loadLog(); }
  timers.forEach(clearInterval);
  timers = [setInterval(loadLog, LOG_EVERY), setInterval(loadDaily, DAILY_EVERY), setInterval(renderBot, 15_000)];
}
function stopAll() { feed.stop(); timers.forEach(clearInterval); timers = []; }
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); stopAll(); }
  else startAll(Date.now() - hiddenAt > 20_000);
});
function measure() { document.documentElement.style.setProperty("--kop-h", `${document.querySelector(".kop").offsetHeight}px`); }
addEventListener("resize", () => { measure(); schedule(); });

applyChartTheme();
selectTab(st.tab);
measure();
renderBot();
renderLogboek();
loadInterval(st.iv);
loadDaily();
loadLog();
startAll(false);

const hadController = !!navigator.serviceWorker?.controller;
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
    // Nieuwe versie gevonden terwijl de app open is: één keer herladen zodra die actief is.
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded && hadController) { reloaded = true; location.reload(); } });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => { /* werkt ook zonder */ });
}
