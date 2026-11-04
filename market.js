// Openbare marktdata van Bitvavo (geen sleutel nodig). Live via de websocket; valt die weg,
// dan halen we hetzelfde op via de gewone API (iets trager). Alleen lezen: hier wordt nooit gehandeld.

const REST = "https://api.bitvavo.com/v2";
const WS = "wss://ws.bitvavo.com/v2/";
export const MARKET = "BTC-EUR";
export const INTERVALS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1W": 604800 };

async function get(path) {
  const r = await fetch(`${REST}/${path}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`Bitvavo ${r.status}`);
  return r.json();
}

const candle = (c) => ({ t: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] });

export const fetchCandles = async (interval, limit = 1000) =>
  (await get(`${MARKET}/candles?interval=${interval}&limit=${limit}`)).map(candle).sort((a, b) => a.t - b.t);
export const fetchBook = (depth = 25) => get(`${MARKET}/book?depth=${depth}`);
export const fetchTrades = (limit = 40) => get(`${MARKET}/trades?limit=${limit}`);
export const fetchTicker = () => get(`ticker/24h?market=${MARKET}`);

// Eén verbinding voor alles. Callbacks: onTicker, onTrade, onCandle, onStatus("live"|"traag").
export class Feed {
  constructor(handlers) {
    this.h = handlers;
    this.interval = "1h";
    this.ws = null;
    this.timers = [];
    this.backoff = 1000;
    this.stopped = true;
  }

  get live() { return this.ws?.readyState === 1; }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.poll(); // altijd: het orderboek komt via de API, de rest alleen als de websocket niet werkt
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    try { this.ws?.close(); } catch { /* niets */ }
    this.ws = null;
  }

  setInterval(interval) {
    const old = this.interval;
    this.interval = interval;
    if (this.live && old !== interval) {
      this.send("unsubscribe", [{ name: "candles", interval: [old], markets: [MARKET] }]);
      this.send("subscribe", [{ name: "candles", interval: [interval], markets: [MARKET] }]);
    }
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
      this.send("subscribe", [
        { name: "ticker24h", markets: [MARKET] },
        { name: "trades", markets: [MARKET] },
        { name: "candles", interval: [this.interval], markets: [MARKET] },
      ]);
      this.h.onStatus?.("live");
    };
    ws.onmessage = (m) => {
      let d;
      try { d = JSON.parse(m.data); } catch { return; }
      if (d.event === "ticker24h") (d.data || []).filter((x) => x.market === MARKET).forEach((x) => this.h.onTicker?.(x));
      else if (d.event === "trade" && d.market === MARKET) this.h.onTrade?.(d);
      else if (d.event === "candle" && d.market === MARKET && d.interval === this.interval)
        (d.candle || []).forEach((c) => this.h.onCandle?.(candle(c), d.interval));
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
    const book = async () => { try { this.h.onBook?.(await fetchBook()); } catch { /* volgende keer */ } };
    const slow = async () => {
      if (this.live) return;
      try {
        const [t, trades, cs] = await Promise.all([fetchTicker(), fetchTrades(20), fetchCandles(this.interval, 2)]);
        this.h.onTicker?.(t);
        trades.slice().reverse().forEach((x) => this.h.onTrade?.(x));
        const iv = this.interval;
        cs.forEach((c) => this.h.onCandle?.(c, iv));
      } catch { /* volgende keer */ }
    };
    book(); slow();
    this.timers.push(setInterval(book, 2000), setInterval(slow, 4000));
  }
}
