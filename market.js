// Openbare marktdata van Bitvavo (geen sleutel nodig). Live via de websocket; valt die weg,
// dan halen we hetzelfde op via de gewone API (iets trager). Alleen lezen: hier wordt nooit gehandeld.

const REST = "https://api.bitvavo.com/v2";
const WS = "wss://ws.bitvavo.com/v2/";
export const INTERVALS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1W": 604800 };

async function get(path) {
  const r = await fetch(`${REST}/${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`Bitvavo ${r.status}`);
  return r.json();
}

const candle = (c) => ({ t: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] });

export const fetchCandles = async (market, interval, limit = 1000) =>
  (await get(`${market}/candles?interval=${interval}&limit=${limit}`)).map(candle).sort((a, b) => a.t - b.t);
export const fetchBook = (market, depth = 25) => get(`${market}/book?depth=${depth}`);
export const fetchTrades = (market, limit = 40) => get(`${market}/trades?limit=${limit}`);
export const fetchTickers = () => get("ticker/24h");

// Alle euro-markten met naam en prijsstap (één keer per dag opgehaald, daarna uit het geheugen).
export async function fetchMarkets() {
  const KEY = "meekijk.markten";
  try {
    const c = JSON.parse(localStorage.getItem(KEY));
    if (c && Date.now() - c.at < 86_400_000 && c.list?.length) return c.list;
  } catch { /* opnieuw ophalen */ }
  const [markets, assets] = await Promise.all([get("markets"), get("assets")]);
  const names = Object.fromEntries(assets.map((a) => [a.symbol, a.name]));
  const list = markets.filter((m) => m.quote === "EUR" && m.status === "trading").map((m) => ({
    market: m.market, base: m.base, name: names[m.base] || m.base,
    decimals: m.tickSize ? Math.max(0, Math.round(-Math.log10(+m.tickSize))) : null,
  }));
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), list })); } catch { /* niets */ }
  return list;
}

// Eén verbinding voor alles. `market` is de munt op het grafiekscherm (transacties en candles),
// `watch` de munten waarvan we de koers willen (lijst en overzicht).
export class Feed {
  constructor(handlers) {
    this.h = handlers;
    this.market = "BTC-EUR";
    this.interval = "1h";
    this.watch = [];
    this.ws = null;
    this.timers = [];
    this.backoff = 1000;
    this.stopped = true;
    this.detail = true;    // grafiekscherm open: orderboek, transacties en candles nodig
  }

  get live() { return this.ws?.readyState === 1; }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.poll();
    this.snapshot();
  }

  // Direct de laatste transacties en het orderboek van de munt ophalen. De websocket stuurt alleen
  // nieuwe transacties; bij een rustige munt bleef de lijst anders lang leeg.
  async snapshot() {
    if (this.stopped || !this.detail) return;
    const m = this.market;
    try {
      const [book, trades] = await Promise.all([fetchBook(m), fetchTrades(m, 30)]);
      if (m !== this.market) return;
      this.h.onBook?.(book, m);
      trades.slice().reverse().forEach((x) => this.h.onTrade?.(x));
    } catch { /* de gewone ronde haalt het zo op */ }
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    try { this.ws?.close(); } catch { /* niets */ }
    this.ws = null;
  }

  channels() {
    const tick = [...new Set([...this.watch, this.market])];
    return [
      { name: "ticker24h", markets: tick },
      { name: "trades", markets: [this.market] },
      { name: "candles", interval: [this.interval], markets: [this.market] },
    ];
  }

  // Na elke wijziging (andere munt, interval of lijst) opnieuw abonneren.
  resubscribe(old) {
    if (!this.live) return;
    if (old) this.send("unsubscribe", old);
    this.send("subscribe", this.channels());
  }

  set(changes) {
    const old = this.live ? this.channels() : null;
    const nieuw = (changes.market && changes.market !== this.market) || (changes.detail && !this.detail);
    Object.assign(this, changes);
    this.resubscribe(old);
    if (nieuw) this.snapshot();
  }

  send(action, channels) {
    try { this.ws.send(JSON.stringify({ action, channels })); } catch { /* niets */ }
  }

  connect() {
    if (this.stopped || typeof WebSocket === "undefined") return;
    let ws;
    try { ws = new WebSocket(WS); } catch { return this.retry(); }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.send("subscribe", this.channels());
      this.h.onStatus?.("live");
    };
    ws.onmessage = (m) => {
      let d;
      try { d = JSON.parse(m.data); } catch { return; }
      if (d.event === "ticker24h") (d.data || []).forEach((x) => this.h.onTicker?.(x));
      else if (d.event === "trade" && d.market === this.market) this.h.onTrade?.(d);
      else if (d.event === "candle" && d.market === this.market && d.interval === this.interval)
        (d.candle || []).forEach((c) => this.h.onCandle?.(candle(c), d.market, d.interval));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.h.onStatus?.("traag");
      this.retry();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* niets */ } };
  }

  retry() {
    if (this.stopped) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    setTimeout(() => this.connect(), wait);
  }

  poll() {
    // Orderboek altijd via de API (alleen als het grafiekscherm open is); de rest alleen zonder websocket.
    const book = async () => {
      if (!this.detail) return;
      const m = this.market;
      try { const b = await fetchBook(m); if (m === this.market) this.h.onBook?.(b, m); } catch { /* volgende keer */ }
    };
    const fast = async () => {
      if (this.live || !this.detail) return;
      const m = this.market, iv = this.interval;
      try {
        const [trades, cs] = await Promise.all([fetchTrades(m, 20), fetchCandles(m, iv, 2)]);
        if (m !== this.market) return;
        trades.slice().reverse().forEach((x) => this.h.onTrade?.(x));
        cs.forEach((c) => this.h.onCandle?.(c, m, iv));
      } catch { /* volgende keer */ }
    };
    const tickers = async () => {
      if (this.live) return;
      try {
        const want = new Set([...this.watch, this.market]);
        (await fetchTickers()).filter((t) => want.has(t.market)).forEach((t) => this.h.onTicker?.(t));
      } catch { /* volgende keer */ }
    };
    book(); fast(); tickers();
    this.timers.push(setInterval(book, 2000), setInterval(fast, 4000), setInterval(tickers, 8000));
  }
}
