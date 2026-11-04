// Meekijkapp: alleen lezen. Geen Bitvavo-sleutels, geen knoppen die handelen.
// Markten (koersen, candles, orderboek, transacties): openbare Bitvavo-data, live via websocket.
// Bots (saldo, besluiten, logboek): privé-repo, met een leessleutel die alleen op dit toestel staat.
import * as core from "./core.js?v=8";
import * as mk from "./market.js?v=8";
import { createChart, CrosshairMode, LineStyle } from "./vendor/lightweight-charts.mjs?v=8";

const $ = (id) => document.getElementById(id);
const KEY = { cfg: "meekijk.cfg", thema: "meekijk.thema", iv: "meekijk.interval", tab: "meekijk.tab",
  lagen: "meekijk.lagen", markt: "meekijk.markt", lijst: "meekijk.lijst" };
const LOG_EVERY = 5 * 60_000;
const DAILY_EVERY = 10 * 60_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

// Je bots. Het totaal op het beginscherm telt ze allemaal op. Een tweede bot = hier een regel erbij
// (met een eigen logboekbestand); zolang hij hetzelfde logboekformaat schrijft werkt de rest vanzelf.
const BOTS = [
  { id: "btc", naam: "Trendbot bitcoin", markt: "BTC-EUR", branch: "logboek", bestand: "logboek.jsonl",
    stopBestand: "STOP", workflow: "bot-dagelijks.yml", start: core.START_EUR },
];
const BTC = "BTC-EUR";
const STANDAARD_LIJST = ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR", "ADA-EUR", "LINK-EUR"];
const VIEWS = { overzicht: "Overzicht", markten: "Markten", grafiek: "Grafiek" };

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* niets */ } },
};
const geldigeMarkt = (m) => typeof m === "string" && /^[A-Z0-9]+-EUR$/.test(m);

const st = {
  cfg: store.get(KEY.cfg),
  bot: Object.fromEntries(BOTS.map((b) => [b.id, { log: null, stop: null, runs: null }])),
  vars: null, logAt: null, logErr: null,
  view: "overzicht",
  markets: new Map(), tick: {},
  lijst: (Array.isArray(store.get(KEY.lijst)) ? store.get(KEY.lijst) : STANDAARD_LIJST).filter(geldigeMarkt),
  zoek: "",
  markt: geldigeMarkt(store.get(KEY.markt)) ? store.get(KEY.markt) : BTC,
  daily: null, waardeCandles: null,
  last: null, trades: [], tradeIds: new Set(), book: null,
  iv: mk.INTERVALS[store.get(KEY.iv)] ? store.get(KEY.iv) : "1h", candles: [],
  lagen: { sma: true, trades: true, vol: true, ...(store.get(KEY.lagen) || {}) },
  tab: store.get(KEY.tab) === "trans" ? "trans" : "boek", shown: 6,
};
const bots = () => BOTS.map((b) => ({ ...b, ...st.bot[b.id] }));

// ---------------- opmaak ----------------
const tz = { timeZone: "Europe/Amsterdam" };
const nf = new Map();
const num = (d, min = d) => {
  const k = `${d}/${min}`;
  if (!nf.has(k)) nf.set(k, new Intl.NumberFormat("nl-NL", { minimumFractionDigits: min, maximumFractionDigits: d }));
  return nf.get(k);
};
const base = (m) => m.split("-")[0];
const info = (m) => st.markets.get(m) || { market: m, base: base(m), name: base(m), decimals: null };
// Prijsstap van de munt (BTC in hele euro's, goedkope munten met veel decimalen); onbekend: gok op grootte.
function decimalen(m, x) {
  const d = info(m).decimals;
  if (d != null) return Math.min(d, 12);
  const a = Math.abs(x || 0);
  return a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 8;
}
const prijs = (x, m = st.markt) => (Number.isFinite(x) ? num(decimalen(m, x)).format(x) : "–");
const euro = (x, m) => (Number.isFinite(x) ? "€" + prijs(x, m) : "–");
const heel = (x) => (Number.isFinite(x) ? num(0).format(x) : "–");
function aantal(x) {
  if (!Number.isFinite(x)) return "–";
  const a = Math.abs(x);
  return num(a >= 1000 ? 0 : a >= 10 ? 2 : a >= 1 ? 4 : 8).format(x);   // onder 1: vaste 8 decimalen, rechte kolom
}
const btc = (x) => (Number.isFinite(x) ? x.toFixed(8).replace(".", ",") : "–");
const tijd = (ms) => new Date(ms).toLocaleTimeString("nl-NL", { ...tz, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const datumTijd = (d) => new Date(d).toLocaleString("nl-NL", { ...tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dag = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("nl-NL", { ...tz, day: "numeric", month: "long" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const teken = (x) => (x >= 0 ? "+" : "−");
const cls = (x) => (x >= 0 ? "op" : "neer");
const plusEur = (x) => (Number.isFinite(x) ? `${teken(x)}${core.eur(Math.abs(x))}` : "–");
const plusPct = (x, d = 2) => (Number.isFinite(x) ? `${teken(x)}${core.pct(Math.abs(x), d)}` : "–");
const wijziging = (t) => (t?.open > 0 && t?.last > 0 ? (t.last - t.open) / t.open : null);

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
  try { localStorage.setItem(KEY.thema, next); } catch { /* niets */ }
  applyTheme();
});
matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", applyTheme);

function chartTheme() {
  const lijn = css("--lijn"), sterk = css("--lijn-sterk");
  return {
    layout: { background: { type: "solid", color: css("--paneel") }, textColor: css("--zacht"), fontSize: 11,
      fontFamily: "Lato, 'Helvetica Neue', Arial, sans-serif", attributionLogo: false },
    grid: { vertLines: { color: lijn }, horzLines: { color: lijn } },
    rightPriceScale: { borderColor: lijn }, timeScale: { borderColor: lijn },
    crosshair: { vertLine: { color: sterk, labelBackgroundColor: css("--paneel-2") },
      horzLine: { color: sterk, labelBackgroundColor: css("--paneel-2") } },
  };
}
function applyTheme() {
  chart.applyOptions(chartTheme());
  const op = css("--op"), neer = css("--neer");
  candleS.applyOptions({ upColor: op, downColor: neer, wickUpColor: op, wickDownColor: neer, priceLineColor: css("--goud") });
  smaS.applyOptions({ color: css("--goud") });
  setChartData(false);
  wchart.applyOptions(waardeTheme());
  const goud = css("--goud");
  waardeS.applyOptions({ lineColor: goud, topColor: alpha(goud, 0.22), bottomColor: alpha(goud, 0.01) });
  holdS.applyOptions({ color: css("--zacht") });
  renderWaarde(true);
}

// ================= beginscherm =================
// Waarde van je bots door de tijd: de stand na elk besluit maal de slotkoers van elk uur, en nu de live koers.
const wchart = createChart($("waardegrafiek"), {
  autoSize: true, handleScroll: false, handleScale: false,
  crosshair: { mode: CrosshairMode.Magnet },
  timeScale: { timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true,
    tickMarkFormatter: (t, type) => tickLabel(t, type) },
  rightPriceScale: { scaleMargins: { top: 0.15, bottom: 0.1 } },
  localization: { locale: "nl-NL", priceFormatter: (p) => core.eur(p), timeFormatter: (t) => F.vol.format(new Date(t * 1000)) },
});
function waardeTheme() {
  const t = chartTheme();
  return { ...t, layout: { ...t.layout, background: { type: "solid", color: css("--grond") } },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false } };
}
const waardeS = wchart.addAreaSeries({ lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
const holdS = wchart.addLineSeries({ lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false,
  lastValueVisible: false, crosshairMarkerVisible: false });
let startLine = null;

function botNu(b) {
  const s = b.log ? core.summary(b.log) : null;
  if (!s?.decisions) return { s, pos: null, waarde: null, hold: null };
  const pos = core.position(b.log);
  const p = botPrijs(b.markt);
  const waarde = p && pos ? pos.eur + pos.qty * p : s.value;
  const hold = p ? s.hold_qty * p : s.hold;
  return { s, pos, p, waarde, hold, res: waarde - s.start, vs: waarde - hold };
}
// Wat je bitcoin nu waard is: de hoogste bieding (verkopen kan direct tegen die prijs), anders de laatste koers.
function botPrijs(m) {
  if (m === st.markt && st.book?.bids?.[0]) return +st.book.bids[0][0];
  const t = st.tick[m];
  return t?.bid || t?.last || null;
}

function renderOverzicht() {
  const lijst = bots().map((b) => ({ b, ...botNu(b) }));
  const klaar = lijst.filter((x) => x.waarde != null);
  const totaal = klaar.reduce((a, x) => a + x.waarde, 0);
  const inleg = klaar.reduce((a, x) => a + x.s.start, 0);
  const res = totaal - inleg;
  const el = { tot: $("o-totaal"), ren: $("o-rendement"), uit: $("o-uitleg") };
  if (klaar.length) {
    el.tot.textContent = core.eur(totaal);
    const sinds = klaar.map((x) => x.s.since).sort()[0];
    el.ren.innerHTML = `<b class="${cls(res)}">${plusEur(res)} (${plusPct(res / inleg)})</b> sinds ${esc(dag(sinds))}`;
    const hold = klaar.reduce((a, x) => a + x.hold, 0), vs = totaal - hold;
    el.uit.innerHTML = `Ingelegd: ${core.eur(inleg, 0)}. Had je op de eerste dag voor alles bitcoin gekocht en die vastgehouden, dan had je nu ${core.eur(hold)}. `
      + `Je bot${klaar.length > 1 ? "s staan" : " staat"} daar <b class="${cls(vs)}">${core.eur(Math.abs(vs))} ${vs >= 0 ? "voor" : "achter"}</b>.`;
  } else {
    el.tot.textContent = st.cfg ? "–" : "";
    el.ren.textContent = "";
    el.uit.innerHTML = !st.cfg ? `Koppel je bot om je totaal en rendement te zien. <button class="tekstknop" data-koppel>Bot koppelen</button>`
      : st.logErr ? esc(st.logErr) : bots().some((b) => b.log) ? "Nog geen besluit van de bot. Na de eerste nachtrun staat hier je totaal." : "Logboek laden…";
  }
  renderBots(lijst);
  renderMeldingen(lijst);
  renderWaarde();
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
const gestopt = (b) => b.stop === true || st.vars?.BOT_STOP === "1";

function renderBots(lijst) {
  const nr = nextRun();
  const volgende = nr.toLocaleString("nl-NL", { ...tz, weekday: "long", hour: "2-digit", minute: "2-digit" });
  $("bots").innerHTML = lijst.map(({ b, s, pos, p, waarde, hold, res, vs }) => {
    const stopped = gestopt(b);
    const has = !!s?.decisions;
    const pil = !st.cfg ? "Niet gekoppeld" : stopped ? "Noodstop" : !b.log ? "Laden" : !has ? "Wacht op 1e run"
      : s.mode === "live" ? "Live" : "Paper";
    const kop = `<header class="botkop"><div><h3>${esc(b.naam)}</h3><p>Beslist elke nacht over ${esc(b.markt)}</p></div>
      <span class="stand-pil${has && s.mode === "live" && !stopped ? " live" : ""}${stopped ? " stop" : ""}">${esc(pil)}</span></header>`;
    if (!st.cfg) {
      return `<article class="paneel botkaart">${kop}<p class="botuitleg">Koersen werken al zonder koppeling. Voor saldo, trades en logboek
        is een GitHub-sleutel nodig die alleen mag lezen.</p><p><button class="knop" data-koppel>Bot koppelen</button></p></article>`;
    }
    if (!has) {
      return `<article class="paneel botkaart">${kop}<p class="botuitleg">${st.logErr ? esc(st.logErr) : b.log
        ? `Nog geen besluit in het logboek. Eerste nachtrun: ${esc(volgende)}.` : "Logboek laden…"}</p></article>`;
    }
    // Voorlopig signaal (trendbot): waar sluit de dag ten opzichte van de bot-grens?
    const closes = b.markt === BTC ? closedDaily() : [];
    const g = core.threshold(closes), prov = p ? core.provisional(closes, p) : null;
    const inMunt = pos && p ? pos.qty * p >= 5 : null;
    let zin = "–";
    if (stopped) zin = "niets (noodstop)";
    else if (prov) {
      if (inMunt === true) zin = prov.above ? "bitcoin houden" : "alles verkopen";
      else if (inMunt === false) zin = prov.above ? "bitcoin kopen" : "in euro blijven";
      else zin = prov.above ? "in bitcoin" : "in euro";
    }
    const slot = new Date(nr.getTime() - 17 * 60_000).toLocaleTimeString("nl-NL", { ...tz, hour: "2-digit", minute: "2-digit" });
    return `<article class="paneel botkaart">${kop}
      <div class="botkaarten">
        <div><b>${core.eur(pos && p ? pos.qty * p : null)}</b><span>in ${esc(base(b.markt))}: ${pos?.qty > 0 ? btc(pos.qty) : "niets"}</span></div>
        <div><b>${core.eur(pos?.eur)}</b><span>in euro</span></div>
        ${BOTS.length > 1 ? `<div><b class="${cls(res)}">${plusEur(res)}</b><span>resultaat, ${plusEur(vs)} t.o.v. vasthouden</span></div>` : ""}
        <div><b>${s.orders}</b><span>${s.orders === 1 ? "order" : "orders"}, samen ${core.eur(s.fees)} kosten</span></div>
      </div>
      <p class="botzin">${stopped ? "De noodstop staat aan: vannacht doet de bot niets."
        : prov && g ? `Sluit bitcoin om ${esc(slot)} boven ${core.eur(g, 0)}, dan wil de bot in bitcoin zitten. Nu ${core.eur(p, 0)}, dus <span class="${prov.above ? "op" : "neer"}">${esc(zin)}</span>.`
        : "Koersdata laden…"}</p>
      <p class="botuitleg">Voorlopig: de bot kijkt alleen naar de slotkoers om middernacht (UTC), en die kan tot dan alle kanten op.
        Laatste besluit: <b>${esc(wordFor(s.action))}</b>${s.reason ? `, ${esc(s.reason)}` : ""} (${esc(datumTijd(s.last_at))}).
        Volgende run: ${esc(volgende)} (${esc(over(nr - Date.now()))}), GitHub start soms wat later.</p>
      <p class="botlinks"><button class="tekstknop" data-open="${esc(b.markt)}">Grafiek met trades</button></p>
    </article>`;
  }).join("");
}

function renderMeldingen(lijst) {
  const m = [];
  for (const { b, s } of lijst) {
    if (gestopt(b)) {
      m.push(`<div class="melding stop"><b>Noodstop actief.</b> ${esc(b.naam)} doet niets ${b.stop === true
        ? `tot het bestand ${esc(b.stopBestand)} op de branch ${esc(b.branch)} is verwijderd`
        : "zolang de variabele BOT_STOP op 1 staat"}.</div>`);
    }
    const run = b.runs?.[0];
    if (run && run.status === "completed" && run.conclusion !== "success") {
      m.push(`<div class="melding fout"><b>De laatste nachtrun is mislukt</b> (${datumTijd(run.created_at)}).
        <a href="${esc(run.html_url)}" target="_blank" rel="noopener">Bekijk de run</a>. GitHub mailt je hier ook over.</div>`);
    }
    if (s?.decisions && Date.now() - new Date(s.last_at) > 36 * HOUR) {
      m.push(`<div class="melding fout"><b>Al meer dan anderhalve dag geen besluit.</b> Laatste: ${datumTijd(s.last_at)}. Controleer of de nachtrun nog draait.</div>`);
    }
    if (b.id === "btc" && st.vars?.BOT_MODE && s?.mode && st.vars.BOT_MODE !== s.mode) {
      m.push(`<div class="melding">De bot staat ingesteld op <b>${esc(st.vars.BOT_MODE)}</b>, de laatste run was <b>${esc(s.mode)}</b>. De volgende nachtrun draait als ${esc(st.vars.BOT_MODE)}.</div>`);
    }
  }
  if (st.logErr && st.cfg) m.push(`<div class="melding fout">${esc(st.logErr)}</div>`);
  $("meldingen").innerHTML = m.join("");
}

// Waardelijn: stand na elk besluit (core.history) maal de slotkoers per uur (of per dag na 40 dagen).
let waardeKey = "";
function renderWaarde(force) {
  const b = bots()[0];   // de lijn toont de som; met één bot is dat deze bot
  const h = bots().length === 1 && b.log ? core.history(b.log) : [];
  const s = h.length ? core.summary(b.log) : null;
  const cs = st.waardeCandles?.markt === b.markt ? st.waardeCandles : null;
  const p = botPrijs(b.markt);
  const nu = Date.now();
  $("held-lijn").hidden = !h.length;
  if (!h.length) {
    waardeS.setData([]); holdS.setData([]);
    if (startLine) { waardeS.removePriceLine(startLine); startLine = null; }
    waardeKey = "";
    $("waardenoot").textContent = !st.cfg ? "Koppel je bot om de waarde door de tijd te zien." : "Na de eerste nachtrun begint hier de lijn.";
    return;
  }
  // Niet bij elke koerstik alles opnieuw: alleen als er iets veranderde of elke 15 seconden voor het laatste punt.
  const key = `${b.log.length}/${cs?.at || 0}/${effectiveTheme()}`;
  if (!force && key === waardeKey && nu - (renderWaarde.at || 0) < 15_000) return;
  waardeKey = key;
  renderWaarde.at = nu;
  const pts = new Map(), hold = new Map();
  const stand = (ms) => { let x = null; for (const e of h) { if (Date.parse(e.at) <= ms) x = e; else break; } return x; };
  for (const e of h) {
    pts.set(T(Date.parse(e.at)), e.value);
    hold.set(T(Date.parse(e.at)), s.hold_qty * e.bid);
  }
  for (const c of cs?.list || []) {
    const dicht = c.t + cs.ms;
    if (dicht > nu) continue;
    const x = stand(dicht);
    if (!x) continue;
    pts.set(T(dicht), x.eur + x.qty * c.close);
    hold.set(T(dicht), s.hold_qty * c.close);
  }
  if (p) {
    const x = h[h.length - 1];
    pts.set(T(nu), x.eur + x.qty * p);
    hold.set(T(nu), s.hold_qty * p);
  }
  const rij = (m) => [...m].sort((a, c) => a[0] - c[0]).map(([time, value]) => ({ time, value }));
  waardeS.setData(rij(pts));
  holdS.setData(rij(hold));
  if (startLine) waardeS.removePriceLine(startLine);
  startLine = waardeS.createPriceLine({ price: s.start, color: css("--vaag"), lineWidth: 1, lineStyle: LineStyle.Dotted,
    axisLabelVisible: false, title: "inleg" });
  wchart.timeScale().fitContent();   // vaste lijn (niet te verschuiven): altijd van start tot nu
  const dagen = (nu - Date.parse(h[0].at)) / DAY;
  $("waardenoot").textContent = `${dagen < 2 ? "Live sinds " + dag(s.since) + ", dus nog een korte lijn: hij groeit elk uur." : "Sinds " + dag(s.since) + "."}`
    + ` Per ${cs?.ms === DAY ? "dag" : "uur"} gerekend met de slotkoers, het laatste punt met de live koers.`;
}

async function loadWaardeCandles() {
  const b = BOTS[0], log = st.bot[b.id].log;
  const h = log ? core.history(log) : [];
  if (!h.length) return;
  const span = Date.now() - Date.parse(h[0].at);
  const iv = span < 40 * DAY ? "1h" : "1d", ms = iv === "1h" ? HOUR : DAY;
  try {
    const list = await mk.fetchCandles(b.markt, iv, Math.min(1000, Math.ceil(span / ms) + 3));
    st.waardeCandles = { markt: b.markt, ms, list, at: Date.now() };
    renderWaarde();
  } catch { /* volgende keer */ }
}

// ================= markten =================
function rijMunt(m, { ster = true } = {}) {
  const i = info(m), t = st.tick[m], ch = wijziging(t);
  const op = st.lijst.includes(m);
  return `<div class="munt-rij" data-open="${esc(m)}" role="button" tabindex="0" aria-label="${esc(i.name)} openen">
    <span class="munt" aria-hidden="true">${esc(i.base.slice(0, 1))}</span>
    <span class="m-tekst"><b>${esc(i.base)}</b><small>${esc(i.name)}</small></span>
    <span class="m-prijs">${t?.last ? euro(t.last, m) : "–"}</span>
    <span class="chip${ch == null ? "" : " " + cls(ch)}">${ch == null ? "–" : plusPct(ch)}</span>
    ${ster ? `<button class="ster" data-ster="${esc(m)}" aria-pressed="${op}" aria-label="${op ? "Van je lijst halen" : "Op je lijst zetten"}" title="${op ? "Van je lijst halen" : "Op je lijst zetten"}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8Z" stroke-linejoin="round"/></svg></button>` : ""}
  </div>`;
}

function renderMiniLijst() {
  $("o-markten").innerHTML = st.lijst.length ? st.lijst.map((m) => rijMunt(m, { ster: false })).join("")
    : `<p class="leeg">Nog geen munten op je lijst. <button class="tekstknop" data-view="markten">Kies munten</button></p>`;
}

function renderMarkten() {
  const q = st.zoek.trim().toLowerCase();
  const vol = (m) => +(st.tick[m]?.volumeQuote || 0);
  let html = "";
  if (q) {
    const hits = [...st.markets.values()].filter((x) => x.base.toLowerCase().includes(q) || x.name.toLowerCase().includes(q))
      .sort((a, c) => (c.base.toLowerCase() === q) - (a.base.toLowerCase() === q) || vol(c.market) - vol(a.market)).slice(0, 60);
    html = hits.length ? `<h3 class="lijstkop">Gevonden</h3>` + hits.map((x) => rijMunt(x.market)).join("")
      : `<p class="leeg">${st.markets.size ? `Geen euro-markt op Bitvavo gevonden voor “${esc(st.zoek)}”.` : "Marktenlijst laden…"}</p>`;
  } else {
    html = `<h3 class="lijstkop">Je munten</h3>` + (st.lijst.length ? st.lijst.map((m) => rijMunt(m)).join("")
      : `<p class="leeg">Nog leeg. Tik op de ster bij een munt om hem hier te zetten.</p>`);
    const top = Object.keys(st.tick).filter((m) => m.endsWith("-EUR") && !st.lijst.includes(m) && (!st.markets.size || st.markets.has(m)))
      .sort((a, c) => vol(c) - vol(a)).slice(0, 20);
    if (top.length) html += `<h3 class="lijstkop">Meest verhandeld op Bitvavo (24 uur)</h3>` + top.map((m) => rijMunt(m)).join("");
  }
  $("munten").innerHTML = html;
}

function zetLijst(lijst) {
  st.lijst = lijst;
  store.set(KEY.lijst, lijst);
  feed.set({ watch: watchList() });
  renderMarkten();
  renderMiniLijst();
}
const watchList = () => [...new Set([...st.lijst, ...BOTS.map((b) => b.markt)])];

$("zoek").addEventListener("input", (e) => { st.zoek = e.target.value; renderMarkten(); });

// Klikken in lijsten: ster = lijst aanpassen, rest van de rij = grafiek openen. Ook voor knoppen elders.
document.addEventListener("click", (e) => {
  const ster = e.target.closest("[data-ster]");
  if (ster) {
    const m = ster.dataset.ster;
    zetLijst(st.lijst.includes(m) ? st.lijst.filter((x) => x !== m) : [...st.lijst, m]);
    return;
  }
  const open = e.target.closest("[data-open]");
  if (open) { openMarkt(open.dataset.open); return; }
  const view = e.target.closest("[data-view]");
  if (view) { selectView(view.dataset.view); return; }
  if (e.target.closest("[data-koppel]")) openSetup();
});
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".munt-rij")) { e.preventDefault(); openMarkt(e.target.dataset.open); }
});

let alleAt = 0;
async function loadAlleKoersen() {
  try {
    for (const t of await mk.fetchTickers()) mergeTick(t);
    alleAt = Date.now();
    schedule();
  } catch { /* volgende keer */ }
}
async function loadMarkets() {
  try {
    const list = await mk.fetchMarkets();
    st.markets = new Map(list.map((x) => [x.market, x]));
    renderKop();
    applyPrijsFormaat();
    schedule();
  } catch { /* zonder namen werkt alles ook */ }
}

// ================= grafiekscherm =================
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
const isBot = () => BOTS.some((b) => b.markt === st.markt);

function applyPrijsFormaat() {
  const d = decimalen(st.markt, st.last || st.tick[st.markt]?.last);
  candleS.applyOptions({ priceFormat: { type: "price", precision: d, minMove: +(10 ** -d).toFixed(d) } });
}

const bar = (c) => ({ time: T(c.t), open: c.open, high: c.high, low: c.low, close: c.close });
const volBar = (c) => ({ time: T(c.t), value: c.volume, color: alpha(c.close >= c.open ? css("--op") : css("--neer"), 0.38) });

function setChartData(resetView) {
  const cs = st.candles;
  candleS.setData(cs.map(bar));
  volS.setData(st.lagen.vol ? cs.map(volBar) : []);
  if (st.markt === BTC && st.iv === "1d" && st.lagen.sma) {
    const sma = core.smaSeries(cs.map((c) => c.close));
    smaS.setData(cs.map((c, i) => (sma[i] == null ? null : { time: T(c.t), value: sma[i] })).filter(Boolean));
  } else smaS.setData([]);
  updateGrens();
  updateMarkers();
  // Een verborgen grafiek heeft geen breedte; dan het beeld pas zetten als het grafiekscherm opengaat.
  if (resetView && cs.length) { if (st.view === "grafiek") resetRange(); else rangePending = true; }
  legend();
}
let rangePending = false;
function resetRange() {
  const n = st.candles.length;
  if (!n) return;
  const show = { "1m": 120, "5m": 144, "15m": 160, "1h": 168, "4h": 180, "1d": 365, "1W": 260 }[st.iv] || 150;
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - show), to: n + 4 });
  rangePending = false;
}

function updateGrens() {
  const g = st.markt === BTC ? grens() : null;
  if (grensLine) { candleS.removePriceLine(grensLine); grensLine = null; }
  if (g && st.lagen.sma) {
    grensLine = candleS.createPriceLine({ price: g, color: css("--goud"), lineWidth: 1, lineStyle: LineStyle.Dashed,
      axisLabelVisible: true, title: "bot-grens" });
  }
}

function updateMarkers() {
  if (!st.lagen.trades || !st.candles.length || !isBot()) { candleS.setMarkers([]); return; }
  const cs = st.candles, op = css("--op"), neer = css("--neer");
  const marks = [];
  for (const b of bots().filter((x) => x.markt === st.markt && x.log)) {
    const s = core.summary(b.log);
    for (const o of b.log.filter((e) => e.type === "order" && !e.test && e.mode === s.mode)) {
      const ms = new Date(o.at).getTime();
      let lo = 0, hi = cs.length - 1, idx = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (cs[mid].t <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
      if (idx < 0) continue;
      const buy = o.side === "buy";
      marks.push({ time: T(cs[idx].t), position: buy ? "belowBar" : "aboveBar", color: buy ? op : neer,
        shape: buy ? "arrowUp" : "arrowDown", text: buy ? "koop" : "verkoop" });
    }
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
    + `<span class="${cls(ch)}">${plusPct(ch)}</span>`
    + (sma ? `<span class="sma">gem. 200d ${prijs(sma)}</span>` : "");
}
chart.subscribeCrosshairMove(legend);

let ivReq = 0;
async function loadInterval(iv, resetView = true) {
  st.iv = iv;
  store.set(KEY.iv, iv);
  feed.set({ interval: iv });
  document.querySelectorAll("#intervallen button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.iv === iv)));
  const req = ++ivReq, m = st.markt;
  try {
    const cs = (await mk.fetchCandles(m, iv, 1000)).filter((c, i, a) => i === 0 || c.t > a[i - 1].t);
    if (req !== ivReq || m !== st.markt) return;
    st.candles = cs;
    setChartData(resetView);
  } catch (e) {
    if (req === ivReq) $("ohlc").textContent = "Koersdata niet geladen. Geen internet?";
  }
}

function onCandle(c, m, iv) {
  if (m !== st.markt || iv !== st.iv || !st.candles.length) return;
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

// Andere munt op het grafiekscherm.
function openMarkt(m) {
  if (!geldigeMarkt(m)) return;
  if (m !== st.markt) {
    st.markt = m;
    store.set(KEY.markt, m);
    st.last = st.tick[m]?.last ?? null;
    st.trades = []; st.tradeIds = new Set(); st.book = null; st.candles = [];
    setChartData(false);
    feed.set({ market: m });
    renderKop();
    applyPrijsFormaat();
    loadInterval(st.iv);
    schedule();
  }
  selectView("grafiek");
}

function renderKop() {
  const i = info(st.markt);
  $("m-icoon").textContent = i.base.slice(0, 1);
  $("m-paar").textContent = st.markt;
  $("m-naam").textContent = i.name;
  document.querySelectorAll(".m-base").forEach((x) => { x.textContent = i.base; });
  const bot = isBot();
  $("s-grens-blok").hidden = st.markt !== BTC;
  $("t-sma").hidden = st.markt !== BTC;
  $("t-trades").hidden = !bot;
}

// ---------------- dagkoersen bitcoin: bot-grens en voorlopig signaal ----------------
async function loadDaily() {
  try { st.daily = await mk.fetchCandles(BTC, "1d", 400); } catch { /* volgende keer */ }
  updateGrens();
  schedule(true);
}
function closedDaily() {
  const now = Date.now();
  return (st.daily || []).filter((c) => c.t + DAY <= now).map((c) => c.close);
}
const grens = () => core.threshold(closedDaily());

// ---------------- koersen, transacties, orderboek ----------------
let raf = 0, zwaarAt = 0, zwaarNu = false;
function schedule(zwaar) {
  if (zwaar) zwaarNu = true;
  if (!raf) raf = requestAnimationFrame(() => {
    raf = 0;
    if (st.view === "grafiek") { renderTicker(); renderTrades(); renderBook(); renderStats(); }
    // Overzicht en lijsten hoeven niet bij elke tik: hooguit elke 1,5 seconde.
    if (zwaarNu || Date.now() - zwaarAt > 1500) {
      zwaarAt = Date.now(); zwaarNu = false;
      if (st.view === "overzicht") { renderOverzicht(); renderMiniLijst(); }
      if (st.view === "markten") renderMarkten();
    }
  });
}

function mergeTick(t) {
  if (!t?.market) return;
  const x = st.tick[t.market] || (st.tick[t.market] = {});
  for (const k of ["open", "high", "low", "last", "volume", "volumeQuote", "bid", "ask"]) if (t[k] != null && t[k] !== "") x[k] = +t[k];
}
function onTicker(t) {
  mergeTick(t);
  if (t.market === st.markt && st.last == null && st.tick[t.market].last) setLast(st.tick[t.market].last);
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

function onBook(b, m) { if (m === st.markt) { st.book = b; schedule(); } }

function renderTicker() {
  const t = st.tick[st.markt] || {};
  const p = st.last ?? t.last;
  $("prijs").textContent = p ? prijs(p) : "–";
  const chip = $("wijziging"), ch = p && t.open ? (p - t.open) / t.open : null;
  chip.textContent = ch == null ? "–" : `${plusPct(ch)} 24u`;
  chip.className = `chip${ch == null ? "" : " " + cls(ch)}`;
  if (p) document.title = `${prijs(p)} · ${st.markt}`;
}

function renderStats() {
  const t = st.tick[st.markt] || {};
  $("s-hoog").textContent = prijs(t.high);
  $("s-laag").textContent = prijs(t.low);
  const vq = t.volumeQuote;
  $("s-vol").textContent = t.volume ? `${aantal(t.volume)} ${info(st.markt).base}, ${vq >= 1e6
    ? `€${(vq / 1e6).toFixed(1).replace(".", ",")} mln` : `€${heel(vq)}`}` : "–";
  const bid = st.book?.bids?.[0]?.[0] ?? t.bid, ask = st.book?.asks?.[0]?.[0] ?? t.ask;
  $("s-spread").textContent = bid && ask ? `${prijs(+bid)} / ${prijs(+ask)}` : "–";
  if (st.markt === BTC) {
    const g = grens(), p = botPrijs(BTC);
    $("s-grens").innerHTML = g ? `${heel(g)}${p ? ` <span class="${cls(p - g)}">(${teken(p - g)}${core.pct(Math.abs(p - g) / g)})</span>` : ""}` : "–";
  }
}

function renderTrades() {
  const el = $("trades");
  if (!st.trades.length) { el.innerHTML = `<div class="leeg">Transacties laden…</div>`; return; }
  el.innerHTML = st.trades.slice(0, 40).map((t) =>
    `<div class="rij ${t.side === "buy" ? "op" : "neer"}${t.nieuw ? " nieuw" : ""}"><span>${prijs(t.price)}</span><span>${aantal(t.amount)}</span><span>${tijd(t.ts)}</span></div>`).join("");
  st.trades.forEach((t) => { t.nieuw = false; });
}

function renderBook() {
  const b = st.book;
  if (!b?.asks?.length || !b?.bids?.length) { $("asks").innerHTML = `<div class="leeg">Orderboek laden…</div>`; $("bids").innerHTML = ""; $("midden").textContent = "–"; return; }
  const n = innerWidth < 1024 ? 10 : 12;
  const side = (rows) => { let cum = 0; return rows.slice(0, n).map(([p, a]) => { cum += +p * +a; return { p: +p, a: +a, cum }; }); };
  const asks = side(b.asks), bids = side(b.bids);
  const max = Math.max(asks[asks.length - 1].cum, bids[bids.length - 1].cum);
  const row = (r) => `<div class="rij" style="--d:${((r.cum / max) * 100).toFixed(1)}%"><span>${prijs(r.p)}</span><span>${aantal(r.a)}</span><span>${heel(r.cum)}</span></div>`;
  $("asks").innerHTML = asks.slice().reverse().map(row).join("");
  $("bids").innerHTML = bids.map(row).join("");
  const spread = asks[0].p - bids[0].p, mid = (asks[0].p + bids[0].p) / 2;
  $("midden").innerHTML = `<span>${prijs(st.last ?? mid)}</span><small>spread €${prijs(spread)} (${core.pct(spread / mid, 3)})</small>`;
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
feed.set({ market: st.markt, interval: st.iv, watch: watchList(), detail: false });
// Zonder websocket na 6 s: meld "vertraagd" (de gewone API vult dan aan).
setTimeout(() => { if (!feed.live && $("verbinding").className === "verbinding") feed.h.onStatus("traag"); }, 6000);

// ================= bot (logboek) =================
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
    const [per, vars] = await Promise.all([
      Promise.all(BOTS.map((b) => Promise.all([
        gh(`contents/${b.bestand}?ref=${b.branch}`, true).catch((e) => { if (e.status === 404 && st.bot[b.id].log !== null) throw e; if (e.status === 404) return ""; throw e; }),
        b.stopBestand ? gh(`contents/${b.stopBestand}?ref=${b.branch}`, true).then(() => true, (e) => (e.status === 404 ? false : null)) : null,
        b.workflow ? optional(gh(`actions/workflows/${b.workflow}/runs?per_page=3`)) : null,
      ]))),
      optional(gh("actions/variables?per_page=30")),
    ]);
    BOTS.forEach((b, i) => {
      const [text, stop, runs] = per[i];
      st.bot[b.id] = { log: core.parseLog(text), stop, runs: runs?.workflow_runs ?? null };
    });
    st.vars = vars?.variables ? Object.fromEntries(vars.variables.map((v) => [v.name, v.value])) : null;
    st.logAt = new Date();
    st.logErr = null;
  } catch (e) {
    st.logErr = e.status === 401 ? "De leessleutel werkt niet (meer). Tik op het schuifjes-icoon en vul een nieuwe in."
      : e.status === 404 ? "De sleutel heeft geen toegang tot de repository. Kies bij de sleutel 'Only select repositories' en vink de bot aan."
      : "Logboek niet opgehaald (geen internet?). De app probeert het zo opnieuw.";
  } finally {
    logBusy = false;
  }
  $("bijgewerkt").textContent = st.logAt ? `Logboek opgehaald ${datumTijd(st.logAt)}, ververst elke 5 minuten.` : "";
  schedule(true);
  renderLogboek();
  updateMarkers();
  if (!st.waardeCandles || Date.now() - st.waardeCandles.at > DAILY_EVERY) loadWaardeCandles(); else renderWaarde(true);
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
  const meer = BOTS.length > 1;
  const all = bots().flatMap((b) => (b.log || []).map((x) => ({ ...x, bot: b.naam })))
    .map((x, i) => ({ x, i, t: Date.parse(x.at) || 0 })).sort((a, b) => b.t - a.t || b.i - a.i).map((y) => y.x);
  if (!all.length) { el.innerHTML = `<li><span class="reden">${bots().some((b) => b.log) ? "Nog geen regels in het logboek." : "Laden…"}</span></li>`; return; }
  el.innerHTML = all.slice(0, st.shown).map((x) => `<li>
    <span class="wat">${esc(what(x))}<span class="stand ${x.mode === "live" ? "live" : ""}">${esc(x.mode || "")}</span></span>
    <span class="bedrag">${esc(amount(x))}</span><span class="tijd">${esc(datumTijd(x.at))}${meer ? `, ${esc(x.bot)}` : ""}</span><span></span>
    ${x.reason ? `<span class="reden">${esc(x.reason)}</span>` : ""}</li>`).join("")
    + (all.length > st.shown ? `<li style="display:block;border:0"><button class="meer" id="meer">Toon meer (${all.length - st.shown})</button></li>` : "");
  $("meer")?.addEventListener("click", () => { st.shown += 30; renderLogboek(); });
}

// ================= schermen =================
function selectView(name, push = true) {
  if (!VIEWS[name]) name = "overzicht";
  const was = st.view;
  st.view = name;
  for (const v of Object.keys(VIEWS)) $(`v-${v}`).hidden = v !== name;
  document.querySelectorAll("nav [data-view]").forEach((b) => {
    if (b.dataset.view === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  $("titel").textContent = VIEWS[name];
  document.body.dataset.view = name;
  feed.set({ detail: name === "grafiek" });
  if (name !== "grafiek") document.title = "Handelsbot";
  if (name === "markten" && Date.now() - alleAt > 10_000) loadAlleKoersen();
  if (push && was !== name) { try { history.pushState({ view: name }, "", `#${name}`); } catch { /* niets */ } }
  if (was !== name) scrollTo(0, 0);
  measure();
  schedule(true);
  if (name === "grafiek") {
    renderTicker(); renderStats(); renderBook(); renderTrades();
    if (rangePending) requestAnimationFrame(() => requestAnimationFrame(resetRange));
  }
  if (name === "overzicht" && was !== name) requestAnimationFrame(() => requestAnimationFrame(() => wchart.timeScale().fitContent()));
}
addEventListener("popstate", (e) => selectView(e.state?.view || "overzicht", false));

// tabs onder de grafiek (telefoon)
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

// ================= koppelen =================
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
$("vergeet").addEventListener("click", () => {
  store.del(KEY.cfg); st.cfg = null;
  for (const b of BOTS) st.bot[b.id] = { log: null, stop: null, runs: null };
  dlg.close(); schedule(true); renderLogboek(); updateMarkers(); renderWaarde(true);
});
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
  for (const b of BOTS) st.bot[b.id] = { log: null, stop: null, runs: null };
  schedule(true);
  loadLog();
  selectView("overzicht");
});

// ================= start en verversen =================
let timers = [];
function startAll(reload) {
  feed.start();
  if (reload) { loadInterval(st.iv, false); loadDaily(); loadLog(); loadAlleKoersen(); }
  timers.forEach(clearInterval);
  timers = [setInterval(loadLog, LOG_EVERY), setInterval(() => { loadDaily(); loadWaardeCandles(); }, DAILY_EVERY),
    setInterval(() => schedule(true), 15_000),
    setInterval(() => { if (st.view === "markten") loadAlleKoersen(); }, 10_000)];
}
function stopAll() { feed.stop(); timers.forEach(clearInterval); timers = []; }
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = Date.now(); stopAll(); }
  else startAll(Date.now() - hiddenAt > 20_000);
});
function measure() { document.documentElement.style.setProperty("--kop-h", `${document.querySelector(".appbalk").offsetHeight}px`); }
addEventListener("resize", () => { measure(); schedule(true); });

$("fee").textContent = core.pct(core.FEE, 2);
// Het beginscherm is altijd het eerste scherm; een oude #markten in de adresbalk telt niet.
try { history.replaceState({ view: "overzicht" }, "", location.pathname + location.search); } catch { /* niets */ }
renderKop();
applyTheme();
selectTab(st.tab);
selectView("overzicht", false);
renderLogboek();
loadMarkets();
loadAlleKoersen();
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
