// Rekenkern van de meekijkapp. Puur: geen netwerk, geen DOM. Ook getest in Node (tests/test_app.py),
// waar de uitkomst wordt vergeleken met trader/report.py: app en ochtendrapport moeten hetzelfde zeggen.

// Kosten per order, gelijk aan FEE in trader/report.py (de test bewaakt dat). De eerste echte order
// (4 nov 2026) kostte 0,25%; de 0,36% van 3 nov gold alleen voor de kleine test-order van €5,50.
export const FEE = 0.0025;
export const START_EUR = 100;
export const SMA_DAYS = 200;
const DAY_MS = 86400000;

export function parseLog(text) {
  return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Zelfde regels als report.summary(): alleen de stand (paper/live) van de laatste run.
export function summary(all, startEur = START_EUR) {
  const modes = all.filter((e) => e.type === "decision" && "mode" in e).map((e) => e.mode);
  const entries = modes.length ? all.filter((e) => e.mode === modes[modes.length - 1]) : all;
  const decisions = entries.filter((e) => e.type === "decision");
  const orders = entries.filter((e) => e.type === "order" && !e.test);
  const stops = entries.filter((e) => e.type === "stopped" || e.action === "noodstop");
  if (!decisions.length) return { decisions: 0, orders: 0, stops: stops.length };
  const first = decisions[0], last = decisions[decisions.length - 1];
  const holdQty = startEur / (1 + FEE) / first.ask;
  return {
    mode: last.mode, market: last.market, since: first.at.slice(0, 10), last_at: last.at,
    decisions: decisions.length, orders: orders.length,
    fees: orders.reduce((s, o) => s + (o.fee || 0), 0),
    stops: stops.length, value: last.value_after_eur ?? last.value_eur,
    hold: holdQty * last.bid, hold_qty: holdQty, start: startEur,
    signal: last.last_close > last.sma ? "boven" : "onder",
    distance: Math.abs(last.last_close - last.sma) / last.last_close,
    action: last.action ?? null, reason: last.reason || "",
    last_close: last.last_close, sma: last.sma, last_candle: (last.last_candle || "").slice(0, 10),
  };
}

// Positie direct na de laatste run: saldo uit het besluit, plus de order van die run.
// Bitvavo: bij kopen gaat bedrag + kosten van de euro af, bij verkopen bedrag − kosten erbij (paper idem).
export function position(all) {
  const s = summary(all);
  if (!s.decisions) return null;
  const mine = all.filter((e) => e.mode === s.mode);
  const i = mine.map((e) => e.type).lastIndexOf("decision");
  const d = mine[i];
  let eur = d.eur, qty = d.qty;
  if (d.action === "buy" || d.action === "sell") {
    const o = mine.slice(0, i).reverse().find((e) => e.type === "order" && !e.test);
    if (o && o.side === "buy") { eur -= o.eur + (o.fee || 0); qty += o.qty; }
    if (o && o.side === "sell") { eur += o.eur - (o.fee || 0); qty -= o.qty; }
  }
  return { eur: Math.max(eur, 0), qty: Math.max(qty, 0), at: d.at, mode: d.mode };
}

// Bitvavo-kaarsen [ms, open, high, low, close, volume], nieuwste eerst. Alleen gesloten kaarsen,
// oudste eerst, net als crypto_bitvavo.parse_candles().
export function closedCandles(raw, nowMs) {
  return raw.filter((c) => c[0] + DAY_MS <= nowMs)
    .map((c) => ({ t: c[0], close: +c[4] }))
    .sort((a, b) => a.t - b.t);
}

export function smaSeries(closes, n = SMA_DAYS) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// Voorlopig signaal: wat zou de bot besluiten als de dagkaars nu op `price` sloot?
// Het gemiddelde schuift dan één dag op (oudste slotkoers eruit, deze prijs erin).
export function provisional(closes, price, n = SMA_DAYS) {
  if (closes.length < n - 1 || !(price > 0)) return null;
  const tail = closes.slice(-(n - 1));
  const sma = (tail.reduce((a, b) => a + b, 0) + price) / n;
  return { sma, above: price > sma, distance: Math.abs(price - sma) / price };
}

export function eur(x, decimals = 2) {
  if (typeof x !== "number" || !isFinite(x)) return "–";
  const [i, f] = Math.abs(x).toFixed(decimals).split(".");
  return (x < 0 ? "−" : "") + "€" + i.replace(/\B(?=(\d{3})+$)/g, ".") + (f ? "," + f : "");
}

export function pct(x, decimals = 1) {
  if (typeof x !== "number" || !isFinite(x)) return "–";
  return (x * 100).toFixed(decimals).replace(".", ",") + "%";
}

// De exacte grens voor het volgende besluit. De bot zit in bitcoin als slot > gemiddelde(200), waarbij de
// nieuwe slotkoers zelf meetelt: slot > (S199 + slot) / 200  <=>  slot > S199 / 199.
// Dus: sluit de dag boven het gemiddelde van de laatste 199 gesloten dagen, dan wil de bot bitcoin.
export function threshold(closes, n = SMA_DAYS) {
  if (closes.length < n - 1) return null;
  return closes.slice(-(n - 1)).reduce((a, b) => a + b, 0) / (n - 1);
}
