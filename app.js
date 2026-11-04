// Meekijkapp: alleen lezen. Geen Bitvavo-sleutels, geen knoppen die handelen.
// Bronnen: logboek (branch `logboek` van de privé-repo, via een leessleutel op dit toestel)
// en de openbare koers van Bitvavo (geen sleutel nodig).
import * as core from "./core.js";

const BRANCH = "logboek";
const WORKFLOW = "bot-dagelijks.yml";
const MARKET = "BTC-EUR";
const CFG_KEY = "meekijk.cfg";
const PRICE_EVERY_MS = 30_000;
const LOG_EVERY_MS = 5 * 60_000;
const $ = (id) => document.getElementById(id);

const state = { cfg: null, log: null, stop: false, runs: null, vars: null, candles: null,
  book: null, priceAt: null, logAt: null, days: 365, shown: 25 };

// ---------- instellingen (alleen op dit toestel) ----------
function loadCfg() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || null; } catch { return null; }
}
function saveCfg(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); return true; } catch { return false; }
}
function forgetCfg() {
  try { localStorage.removeItem(CFG_KEY); } catch { /* niets */ }
}

// ---------- netwerk ----------
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

async function gh(path, raw = false) {
  const r = await fetch(`https://api.github.com/repos/${state.cfg.repo}${path ? "/" + path : ""}`, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${state.cfg.token}`,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) throw new HttpError(r.status, `GitHub ${r.status}`);
  return raw ? r.text() : r.json();
}

async function bitvavo(path) {
  const r = await fetch(`https://api.bitvavo.com/v2/${path}`, { cache: "no-store" });
  if (!r.ok) throw new HttpError(r.status, `Bitvavo ${r.status}`);
  return r.json();
}

async function optional(p) {
  try { return await p; } catch (e) { return e instanceof HttpError && (e.status === 403 || e.status === 404) ? null : Promise.reject(e); }
}

async function loadLog() {
  const [text, stop, runs, vars] = await Promise.all([
    gh(`contents/logboek.jsonl?ref=${BRANCH}`, true).catch((e) => {
      if (e.status === 404) return ""; // nog geen logboek
      throw e;
    }),
    gh(`contents/STOP?ref=${BRANCH}`, true).then(() => true, (e) => (e.status === 404 ? false : null)),
    optional(gh(`actions/workflows/${WORKFLOW}/runs?per_page=3`)),
    optional(gh("actions/variables?per_page=30")),
  ]);
  state.log = core.parseLog(text);
  state.stop = stop;
  state.runs = runs?.workflow_runs ?? null;
  state.vars = vars?.variables ? Object.fromEntries(vars.variables.map((v) => [v.name, v.value])) : null;
  state.logAt = new Date();
}

async function loadMarket(withCandles) {
  const jobs = [bitvavo(`ticker/book?market=${MARKET}`)];
  if (withCandles) jobs.push(bitvavo(`${MARKET}/candles?interval=1d&limit=1000`));
  const [book, raw] = await Promise.all(jobs);
  state.book = { bid: +book.bid, ask: +book.ask };
  state.priceAt = new Date();
  if (raw) state.candles = core.closedCandles(raw, Date.now());
}

// ---------- weergave ----------
const tz = { timeZone: "Europe/Amsterdam" };
const fmtTijd = (d) => new Date(d).toLocaleString("nl-NL", { ...tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDag = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("nl-NL", { ...tz, day: "numeric", month: "long" });
const fmtKlok = (d) => new Date(d).toLocaleTimeString("nl-NL", { ...tz, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function nextRun(now = new Date()) {
  const n = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 17));
  if (n <= now) n.setUTCDate(n.getUTCDate() + 1);
  return n;
}

function render() {
  const s = state.log ? core.summary(state.log) : null;
  const pos = state.log ? core.position(state.log) : null;
  const bid = state.book?.bid;
  const live = s?.mode === "live";

  // Kop
  $("stand").textContent = !s ? "Laden…" : !s.decisions ? "Nog geen nachtrun"
    : live ? "Live · echt geld" : "Paper · nep-geld";
  const nowValue = pos && bid ? pos.eur + pos.qty * bid : null;
  $("waarde").textContent = nowValue != null ? core.eur(nowValue) : s?.decisions ? core.eur(s.value) : "–";
  if (pos && bid) {
    const inBtc = pos.qty * bid;
    $("waardeuitleg").textContent = pos.qty > 0
      ? `${fmtBtc(pos.qty)} BTC (${core.eur(inBtc)}) en ${core.eur(pos.eur)} in euro, gerekend met de live biedprijs.`
      : `Alles in euro: de bot heeft nu geen bitcoin.`;
  } else if (s && !s.decisions) {
    $("waardeuitleg").textContent = "Het logboek heeft nog geen besluit van de bot. Na de eerste nachtrun verschijnt hier de stand.";
  } else {
    $("waardeuitleg").textContent = "";
  }
  if (state.book) {
    $("koers").textContent = `BTC ${core.eur(state.book.bid, 0)} · live van Bitvavo, ${fmtKlok(state.priceAt)}`;
    $("stip").classList.add("aan");
  }

  renderMeldingen(s);
  renderCijfers(s, pos, bid);
  renderGrafiek();
  renderVolgende(s, pos);
  renderLogboek(s);
  $("bijgewerkt").textContent = state.logAt ? `Logboek opgehaald ${fmtTijd(state.logAt)} · ververst elke 5 minuten zolang de app open is` : "";
}

const fmtBtc = (q) => q.toFixed(8).replace(".", ",");

function renderMeldingen(s) {
  const m = [];
  const v = state.vars || {};
  if (state.stop === true || v.BOT_STOP === "1") {
    m.push(`<div class="melding stop"><b>Noodstop actief.</b> De bot doet niets ${state.stop === true
      ? "tot het bestand STOP op de branch logboek is verwijderd" : "zolang de variabele BOT_STOP op 1 staat"}.</div>`);
  }
  const run = state.runs?.[0];
  if (run && run.status === "completed" && run.conclusion !== "success") {
    m.push(`<div class="melding fout"><b>De laatste nachtrun is mislukt</b> (${fmtTijd(run.created_at)}).
      <a href="${esc(run.html_url)}" target="_blank" rel="noopener">Bekijk de run op GitHub</a>. GitHub stuurt je hierover ook een e-mail.</div>`);
  }
  if (s?.decisions && Date.now() - new Date(s.last_at) > 36 * 3600_000) {
    m.push(`<div class="melding fout"><b>Al meer dan anderhalve dag geen besluit in het logboek.</b> Laatste: ${fmtTijd(s.last_at)}.
      Controleer of de nachtrun nog draait.</div>`);
  }
  if (v.BOT_MODE && s?.mode && v.BOT_MODE !== s.mode) {
    m.push(`<div class="melding">De bot staat ingesteld op <b>${esc(v.BOT_MODE)}</b>, maar de laatste run was <b>${esc(s.mode)}</b>.
      De volgende nachtrun draait als ${esc(v.BOT_MODE)}.</div>`);
  }
  $("meldingen").innerHTML = m.join("");
}

function renderCijfers(s, pos, bid) {
  if (!s?.decisions) { $("cijfers").innerHTML = ""; return; }
  const holdNow = bid ? s.hold_qty * bid : s.hold;
  const valNow = pos && bid ? pos.eur + pos.qty * bid : s.value;
  const diff = valNow - holdNow;
  const cls = diff >= 0 ? "plus" : "min";
  const res = valNow - s.start;
  $("cijfers").innerHTML = `
    <div><b class="${res >= 0 ? "plus" : "min"}">${res >= 0 ? "+" : "−"}${core.eur(Math.abs(res))}</b>
      <span>resultaat sinds de start (${core.eur(s.start, 0)} op ${esc(fmtDag(s.since))}), geschat met de live koers</span></div>
    <div><b class="${cls}">${diff >= 0 ? "+" : "−"}${core.eur(Math.abs(diff))}</b>
      <span>verschil met bitcoin vasthouden (${core.eur(holdNow)})</span></div>
    <div><b>${core.eur(s.value)}</b><span>waarde bij de laatste run, ${fmtTijd(s.last_at)}</span></div>
    <div><b>${s.orders}</b><span>orders sinds de start, kosten ${core.eur(s.fees)}</span></div>`;
}

function renderGrafiek() {
  const fig = $("grafiek");
  const c = state.candles;
  if (!c || c.length < 30) {
    fig.innerHTML = `<div class="leeg">${state.candles ? "Te weinig koersdata" : "Koersdata laden…"}</div>`;
    return;
  }
  const closes = c.map((x) => x.close);
  const sma = core.smaSeries(closes);
  const from = Math.max(0, c.length - state.days);
  const pts = c.slice(from).map((x, i) => ({ t: x.t, p: x.close, s: sma[from + i] }));
  if (state.book) pts.push({ t: Date.now(), p: state.book.bid, s: null, nu: true });

  const W = Math.max(280, Math.round(fig.clientWidth || 640)), H = Math.max(200, Math.round(fig.clientHeight || 360));
  const L = 2, R = 40, T = 10, B = 24;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const vals = pts.flatMap((x) => (x.s ? [x.p, x.s] : [x.p]));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const X = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = (k) => pts.filter((x) => x[k] != null).map((x, i) => `${i ? "L" : "M"}${X(x.t).toFixed(1)},${Y(x[k]).toFixed(1)}`).join("");

  // raster: 4 nette prijsniveaus
  const step = niceStep((hi - lo) / 4);
  let grid = "";
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    grid += `<line class="raster" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`
      + `<text class="as" x="${W - R + 6}" y="${(Y(v) + 3.5).toFixed(1)}">${(v / 1000).toLocaleString("nl-NL")}k</text>`;
  }
  // maanden onderaan
  let months = "";
  const d = new Date(t0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCHours(0, 0, 0, 0);
  const span = (t1 - t0) / 86400000;
  const every = span > 500 ? 6 : span > 200 ? 2 : 1;
  for (; d.getTime() <= t1; d.setUTCMonth(d.getUTCMonth() + every)) {
    const label = d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : d.toLocaleString("nl-NL", { month: "short", timeZone: "UTC" }).replace(".", "");
    months += `<text class="as" x="${X(d.getTime()).toFixed(1)}" y="${H - 6}" text-anchor="middle">${label}</text>`;
  }
  // orders van de bot (niet de test-orders), alleen de huidige stand
  const s = state.log ? core.summary(state.log) : null;
  let marks = "";
  for (const o of (state.log || []).filter((e) => e.type === "order" && !e.test && e.mode === s?.mode)) {
    const t = new Date(o.at).getTime();
    if (t < t0 || t > t1 + 86400000) continue;
    marks += `<circle class="${o.side === "buy" ? "koop" : "verkoop"}" cx="${X(Math.min(t, t1)).toFixed(1)}" cy="${Y(o.price).toFixed(1)}" r="4.5"><title>${o.side === "buy" ? "Koop" : "Verkoop"} ${fmtTijd(o.at)} tegen ${core.eur(o.price, 0)}</title></circle>`;
  }
  const last = pts[pts.length - 1];
  const nu = last.nu ? `<circle class="nu" cx="${X(last.t).toFixed(1)}" cy="${Y(last.p).toFixed(1)}" r="3.5"/>` : "";
  fig.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Slotkoers BTC-EUR en 200-daags gemiddelde">
    ${grid}${months}<path class="p-sma" d="${path("s")}"/>
    <path class="p-koers" d="${path("p")}"/>${marks}${nu}</svg>`;
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

function renderVolgende(s, pos) {
  const el = $("volgende");
  const nr = nextRun();
  const when = nr.toLocaleString("nl-NL", { ...tz, weekday: "long", hour: "2-digit", minute: "2-digit" });
  const parts = [];
  const closes = state.candles?.map((x) => x.close);
  const prov = closes && state.book ? core.provisional(closes, state.book.bid) : null;
  const inBtc = pos ? pos.qty * (state.book?.bid || 0) >= 5 : null;
  if (state.stop === true || state.vars?.BOT_STOP === "1") {
    parts.push(`<p class="groot">De noodstop staat aan: vannacht doet de bot niets, wat de koers ook doet.</p>`);
  } else if (prov) {
    const want = prov.above ? "in bitcoin" : "in euro";
    let doet = "";
    if (inBtc === true) doet = prov.above ? "Dan blijft de bitcoin staan." : "Dan verkoopt de bot alle bitcoin.";
    if (inBtc === false) doet = prov.above ? "Dan koopt de bot bitcoin (tot €100)." : "Dan blijft alles in euro.";
    parts.push(`<p class="groot">Sluit de koers vannacht op ${core.eur(state.book.bid, 0)}, dan wil de bot ${want} zitten. ${doet}</p>`);
    parts.push(`<p>Het 200-daags gemiddelde komt dan op ongeveer ${core.eur(prov.sma, 0)}. De koers ligt daar nu
      ${core.pct(prov.distance)} ${prov.above ? "boven" : "onder"}. Dit is een voorlopige stand: de bot kijkt alleen naar de
      slotkoers om middernacht (UTC) en die kan tot dan nog alle kanten op.</p>`);
  } else if (s?.decisions) {
    parts.push(`<p class="groot">Laatste slotkoers ${core.eur(s.last_close, 0)}, ${s.signal} het gemiddelde van ${core.eur(s.sma, 0)}.</p>`);
  }
  parts.push(`<p>Volgende besluit: ${when} (GitHub start soms tot een uur later).${s?.decisions
    ? ` Laatste besluit: <b>${esc(wordFor(s.action))}</b>${s.reason ? `, ${esc(s.reason)}` : ""}.` : ""}</p>`);
  el.innerHTML = parts.join("");
}

const WORDS = { buy: "kopen", sell: "verkopen", niets: "niets doen", noodstop: "noodstop" };
const wordFor = (a) => WORDS[a] || a || "–";

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
  const all = (state.log || []).slice().reverse();
  const el = $("logboek");
  if (!all.length) { el.innerHTML = `<li><span class="reden">Nog geen regels in het logboek.</span></li>`; return; }
  el.innerHTML = all.slice(0, state.shown).map((x) => `<li>
    <span class="wat">${esc(what(x))}<span class="stand ${x.mode === "live" ? "live" : ""}">${esc(x.mode || "")}</span></span>
    <span class="bedrag">${esc(amount(x))}</span>
    <span class="tijd">${esc(fmtTijd(x.at))}</span><span></span>
    ${x.reason ? `<span class="reden">${esc(x.reason)}</span>` : ""}</li>`).join("")
    + (all.length > state.shown ? `<li style="display:block;border:0"><button class="meer" id="meer">Toon meer (${all.length - state.shown})</button></li>` : "");
  $("meer")?.addEventListener("click", () => { state.shown += 50; renderLogboek(); });
}

// ---------- verversen ----------
let busy = false;
async function refresh({ log = true, candles = true } = {}) {
  if (busy) return;
  busy = true;
  $("vernieuw").classList.add("draait");
  const errors = [];
  await Promise.all([
    log ? loadLog().catch((e) => errors.push(e)) : null,
    loadMarket(candles || !state.candles).catch((e) => errors.push(e)),
  ]);
  busy = false;
  $("vernieuw").classList.remove("draait");
  const auth = errors.find((e) => e.status === 401 || (e.status === 404 && String(e.message).startsWith("GitHub")));
  if (auth) {
    showSetup(auth.status === 401 ? "De sleutel werkt niet (meer). Maak een nieuwe en vul hem opnieuw in."
      : "Repository niet gevonden, of de sleutel heeft er geen leesrecht op.");
    return;
  }
  render();
  if (errors.length) {
    $("meldingen").insertAdjacentHTML("beforeend", `<div class="melding fout">Niet alles kon worden opgehaald
      (${esc(errors.map((e) => e.message).join(", "))}). Geen internet? De app probeert het zo opnieuw.</div>`);
  }
}

let timers = [];
function startTimers() {
  stopTimers();
  timers.push(setInterval(() => refresh({ log: false, candles: false }), PRICE_EVERY_MS));
  timers.push(setInterval(() => refresh({ log: true, candles: true }), LOG_EVERY_MS));
}
function stopTimers() { timers.forEach(clearInterval); timers = []; }

document.addEventListener("visibilitychange", () => {
  if (!state.cfg || $("hoofd").hidden) return;
  if (document.hidden) stopTimers();
  else { const stale = !state.logAt || Date.now() - state.logAt > 60_000; refresh({ log: stale, candles: stale }); startTimers(); }
});

// ---------- schermen ----------
function showSetup(error) {
  stopTimers();
  $("hoofd").hidden = true;
  $("instellen").hidden = false;
  $("repo").value = state.cfg?.repo || "";
  $("token").value = "";
  $("formfout").hidden = !error;
  $("formfout").textContent = error || "";
  let forget = $("vergeet");
  if (state.cfg && !forget) {
    $("form").insertAdjacentHTML("beforeend", `<button type="button" class="licht" id="vergeet">Sleutel van dit toestel wissen</button>
      <button type="button" class="licht" id="terug" style="color:var(--tekst)">Terug zonder wijzigen</button>`);
    $("vergeet").addEventListener("click", () => { forgetCfg(); state.cfg = null; location.reload(); });
    $("terug").addEventListener("click", () => { if (state.cfg) showMain(); });
  }
}

function showMain() {
  $("instellen").hidden = true;
  $("hoofd").hidden = false;
  refresh();
  startTimers();
}

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  // Ruim op wat telefoons toevoegen: spaties, een volledige GitHub-link, ".git" aan het eind.
  const repo = $("repo").value.replace(/\s+/g, "").replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "").replace(/\/+$/, "");
  const token = $("token").value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    $("formfout").hidden = false;
    $("formfout").textContent = "Vul de repository in als eigenaar/naam, bijvoorbeeld iemand/mijn-repo.";
    return;
  }
  const old = state.cfg;
  state.cfg = { repo, token };
  try {
    await gh("", false);
  } catch (e) {
    state.cfg = old;
    $("formfout").hidden = false;
    $("formfout").textContent = e.status === 401 ? "Deze sleutel wordt door GitHub geweigerd."
      : e.status === 404 ? "Repository niet gevonden, of de sleutel heeft er geen toegang toe."
      : `Controle mislukt (${e.message}). Probeer het opnieuw.`;
    return;
  }
  if (!saveCfg(state.cfg)) {
    $("formfout").hidden = false;
    $("formfout").textContent = "Let op: deze browser bewaart niets (privévenster?). De app werkt nu, maar vraagt de sleutel straks opnieuw.";
  }
  showMain();
});
$("naarinstellen").addEventListener("click", () => showSetup());
$("vernieuw").addEventListener("click", () => refresh());
document.querySelector(".bereik").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-dagen]");
  if (!b) return;
  state.days = +b.dataset.dagen;
  document.querySelectorAll(".bereik button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  renderGrafiek();
});

let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderGrafiek, 150); });

// ---------- start ----------
state.cfg = loadCfg();
if (state.cfg?.repo && state.cfg?.token) showMain(); else showSetup();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => { /* app werkt ook zonder */ });
}
