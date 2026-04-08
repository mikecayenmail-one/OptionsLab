import { useState, useMemo, useCallback, useRef, useEffect } from "react";

/* ═══════════════════════════════════════════════════════════════════════════
   BLACK-SCHOLES ENGINE
   ═══════════════════════════════════════════════════════════════════════════ */
function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

function bsPrice(S, K, T, r, sigma, type) {
  if (T <= 0) return type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (sigma <= 0 || S <= 0 || K <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return type === "call"
    ? S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2)
    : K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
}

function bsGreeks(S, K, T, r, sigma, type) {
  if (T <= 0 || sigma <= 0 || S <= 0) return { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const nd1 = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
  return {
    delta: type === "call" ? normalCDF(d1) : normalCDF(d1) - 1,
    gamma: nd1 / (S * sigma * sqrtT),
    theta: (type === "call"
      ? -(S * nd1 * sigma) / (2 * sqrtT) - r * K * Math.exp(-r * T) * normalCDF(d2)
      : -(S * nd1 * sigma) / (2 * sqrtT) + r * K * Math.exp(-r * T) * normalCDF(-d2)) / 365,
    vega: S * nd1 * sqrtT / 100,
    rho: (type === "call" ? 1 : -1) * K * T * Math.exp(-r * T) * normalCDF(type === "call" ? d2 : -d2) / 100,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   STRATEGIES & PNL
   ═══════════════════════════════════════════════════════════════════════════ */
const STRATEGIES = {
  long_call: { name: "Long Call", tag: "Bullish", desc: "Buy a call — unlimited upside, risk limited to premium paid.", accent: "#00e5a0", icon: "↗" },
  long_put: { name: "Long Put", tag: "Bearish", desc: "Buy a put — profit as stock falls below strike minus premium.", accent: "#ff6b6b", icon: "↘" },
  covered_call: { name: "Covered Call", tag: "Neutral+", desc: "Own shares + sell a call. Collect premium, cap upside.", accent: "#fbbf24", icon: "⇄" },
  cash_secured_put: { name: "Cash Secured Put", tag: "Neutral+", desc: "Sell a put backed by cash. Collect premium, risk assignment.", accent: "#a78bfa", icon: "⊝" },
};

function computePnL(strat, p, S, daysLeft) {
  const T = Math.max(daysLeft / 365, 0), n = p.contracts * 100;
  const sigma = p.iv / 100, r = p.rfr / 100;
  if (strat === "long_call") {
    const v = T <= 0 ? Math.max(S - p.strike, 0) : bsPrice(S, p.strike, T, r, sigma, "call");
    return (v - p.premium) * n;
  }
  if (strat === "long_put") {
    const v = T <= 0 ? Math.max(p.strike - S, 0) : bsPrice(S, p.strike, T, r, sigma, "put");
    return (v - p.premium) * n;
  }
  if (strat === "covered_call") {
    const callV = T <= 0 ? Math.max(S - p.strike, 0) : bsPrice(S, p.strike, T, r, sigma, "call");
    return ((S - p.stockPrice) + (p.premium - callV)) * n;
  }
  if (strat === "cash_secured_put") {
    const putV = T <= 0 ? Math.max(p.strike - S, 0) : bsPrice(S, p.strike, T, r, sigma, "put");
    return (p.premium - putV) * n;
  }
  return 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FINNHUB API HOOKS
   ═══════════════════════════════════════════════════════════════════════════ */
function useFinnhub(apiKey) {
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const timerRef = useRef(null);
  const cacheRef = useRef({});

  const searchSymbol = useCallback((query) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query || query.length < 1 || !apiKey) { setSearchResults([]); return; }
    setSearchLoading(true);
    timerRef.current = setTimeout(async () => {
      try {
        const resp = await fetch(
          `https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${apiKey}`
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const filtered = (data.result || [])
          .filter(r => r.type === "Common Stock" || r.type === "ETP" || r.type === "ADR" || r.type === "ETF")
          .filter(r => !r.symbol.includes("."))
          .slice(0, 8);
        setSearchResults(filtered);
      } catch (e) {
        console.error("Search error:", e);
        setSearchResults([]);
      }
      setSearchLoading(false);
    }, 300);
  }, [apiKey]);

  const getQuote = useCallback(async (symbol) => {
    if (!apiKey) { setQuoteError("Enter your Finnhub API key first."); return null; }
    if (cacheRef.current[symbol] && Date.now() - cacheRef.current[symbol].ts < 30000) {
      return cacheRef.current[symbol].data;
    }
    setQuoteLoading(true);
    setQuoteError("");
    try {
      const [quoteResp, profileResp] = await Promise.all([
        fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`),
        fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`),
      ]);
      if (!quoteResp.ok) throw new Error(`Quote HTTP ${quoteResp.status}`);
      const quote = await quoteResp.json();
      const profile = await profileResp.json();
      if (!quote.c || quote.c === 0) { setQuoteError(`No price data for ${symbol}. Check the ticker.`); setQuoteLoading(false); return null; }
      const result = {
        symbol,
        name: profile.name || symbol,
        price: quote.c,
        change: quote.d || 0,
        changePercent: quote.dp || 0,
        high: quote.h,
        low: quote.l,
        open: quote.o,
        prevClose: quote.pc,
        industry: profile.finnhubIndustry || null,
        marketCap: profile.marketCapitalization || null,
      };
      cacheRef.current[symbol] = { data: result, ts: Date.now() };
      setQuoteLoading(false);
      return result;
    } catch (e) {
      console.error("Quote error:", e);
      setQuoteError(`Failed to fetch ${symbol}. Check your API key and try again.`);
      setQuoteLoading(false);
      return null;
    }
  }, [apiKey]);

  return { searchResults, searchLoading, searchSymbol, getQuote, quoteLoading, quoteError };
}

/* ═══════════════════════════════════════════════════════════════════════════
   CSS
   ═══════════════════════════════════════════════════════════════════════════ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
:root {
  --bg: #060810; --card: rgba(10,14,26,0.8); --input: rgba(14,20,38,0.9);
  --border: rgba(80,100,140,0.1); --focus: rgba(0,229,160,0.4);
  --t1: #e8ecf4; --t2: #7a8ba8; --t3: #3e4d66;
  --green: #00e5a0; --red: #ff6b6b; --amber: #fbbf24;
  --font: 'Outfit', sans-serif; --mono: 'IBM Plex Mono', monospace;
}
* { margin:0; padding:0; box-sizing:border-box; }
::-webkit-scrollbar { width:5px; } ::-webkit-scrollbar-thumb { background:rgba(80,100,140,0.2); border-radius:3px; }

@keyframes fadeUp { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
@keyframes spin { to{transform:rotate(360deg)} }
@keyframes gradShift { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
@keyframes dropIn { from{opacity:0;transform:translateY(-6px) scale(.98)} to{opacity:1;transform:translateY(0) scale(1)} }

.card { background:var(--card); backdrop-filter:blur(20px); border:1px solid var(--border); border-radius:16px; }
.inp {
  background:var(--input); border:1.5px solid var(--border); border-radius:10px;
  color:var(--t1); font-family:var(--mono); font-size:14px; font-weight:500;
  padding:10px 14px; width:100%; outline:none; transition:border .25s,box-shadow .25s;
}
.inp:focus { border-color:var(--focus); box-shadow:0 0 0 3px rgba(0,229,160,.12); }
.inp::placeholder { color:var(--t3); }

.sbtn {
  padding:12px 16px; border-radius:12px; border:1.5px solid var(--border);
  background:rgba(10,14,26,.5); cursor:pointer; text-align:left;
  transition:all .2s cubic-bezier(.4,0,.2,1); position:relative; overflow:hidden;
}
.sbtn:hover { transform:translateY(-1px); border-color:rgba(80,100,140,.22); }

.dd {
  position:absolute; top:calc(100% + 6px); left:0; right:0;
  background:rgba(10,14,26,.97); backdrop-filter:blur(24px);
  border:1.5px solid rgba(80,100,140,.15); border-radius:14px;
  max-height:300px; overflow-y:auto; z-index:100;
  animation:dropIn .2s ease-out; box-shadow:0 20px 60px rgba(0,0,0,.5);
}
.ddi {
  padding:12px 16px; cursor:pointer; display:flex; align-items:center; gap:12px;
  transition:background .15s; border-bottom:1px solid rgba(80,100,140,.06);
}
.ddi:last-child { border-bottom:none; }
.ddi:hover { background:rgba(0,229,160,.05); }
.tbadge {
  font-family:var(--mono); font-weight:700; font-size:13px;
  padding:4px 10px; border-radius:6px; background:rgba(0,229,160,.1);
  color:var(--green); min-width:56px; text-align:center;
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   API KEY PANEL
   ═══════════════════════════════════════════════════════════════════════════ */
function ApiKeyPanel({ apiKey, setApiKey }) {
  const [input, setInput] = useState(apiKey);
  const [saved, setSaved] = useState(!!apiKey);
  const save = () => { setApiKey(input.trim()); setSaved(true); };

  return (
    <div className="card" style={{ padding: "18px 22px", animation: "fadeUp .4s ease-out" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: apiKey ? "var(--green)" : "var(--red)", boxShadow: apiKey ? "0 0 10px var(--green)" : "0 0 10px var(--red)", transition: "all .3s" }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--t2)", textTransform: "uppercase", letterSpacing: ".06em" }}>Finnhub API Key</span>
      </div>
      {!saved || !apiKey ? (
        <>
          <div style={{ fontSize: 11, color: "var(--t3)", lineHeight: 1.6, marginBottom: 10 }}>
            Real-time data — free key at{" "}
            <a href="https://finnhub.io/register" target="_blank" rel="noreferrer" style={{ color: "var(--green)", textDecoration: "none", fontWeight: 600 }}>finnhub.io</a>
            {" "}(60 calls/min)
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="inp" placeholder="Paste API key..." value={input}
              onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && save()}
              style={{ flex: 1, fontSize: 12 }} />
            <button onClick={save} style={{
              padding: "0 16px", borderRadius: 10,
              background: "linear-gradient(135deg, var(--green), #00c28a)", border: "none",
              cursor: "pointer", fontWeight: 700, fontSize: 12, color: "#060810", fontFamily: "var(--font)",
            }}>Save</button>
          </div>
        </>
      ) : (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--t2)" }}>{apiKey.slice(0, 6)}...{apiKey.slice(-4)}</span>
          <button onClick={() => setSaved(false)} style={{ background: "none", border: "1px solid var(--border)", borderRadius: 8, color: "var(--t3)", fontSize: 11, padding: "4px 12px", cursor: "pointer", fontWeight: 600 }}>Change</button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   STOCK SEARCH PANEL
   ═══════════════════════════════════════════════════════════════════════════ */
function StockSearch({ apiKey, onSelect, selected }) {
  const { searchResults, searchLoading, searchSymbol, getQuote, quoteLoading, quoteError } = useFinnhub(apiKey);
  const [nameQ, setNameQ] = useState("");
  const [tickerQ, setTickerQ] = useState("");
  const [showDD, setShowDD] = useState(false);
  const ddRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const h = (e) => {
      if (ddRef.current && !ddRef.current.contains(e.target) && inputRef.current && !inputRef.current.contains(e.target)) setShowDD(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const handlePick = async (sym, name) => {
    setNameQ(name || sym); setTickerQ(sym); setShowDD(false);
    const data = await getQuote(sym);
    if (data) onSelect(data);
  };

  const handleTickerGo = async () => {
    if (!tickerQ.trim()) return;
    const data = await getQuote(tickerQ.trim().toUpperCase());
    if (data) { setNameQ(data.name); onSelect(data); }
  };

  return (
    <div className="card" style={{ padding: "22px", animation: "fadeUp .5s ease-out", position: "relative" }}>
      <div style={{ position: "absolute", top: -1, right: -1, width: 50, height: 50, background: "linear-gradient(135deg, var(--green) 0%, transparent 70%)", opacity: .08, borderRadius: "0 16px 0 24px", pointerEvents: "none" }} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: selected ? "var(--green)" : "var(--t3)", boxShadow: selected ? "0 0 12px var(--green)" : "none", transition: "all .3s" }} />
        <h3 style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--t2)" }}>Stock Selection</h3>
      </div>

      {/* Name search */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 5 }}>Search by Company Name</label>
        <div style={{ position: "relative" }}>
          <input ref={inputRef} className="inp" placeholder="e.g. Tesla, Apple, NVIDIA..."
            value={nameQ} onChange={e => { setNameQ(e.target.value); searchSymbol(e.target.value); setShowDD(true); }}
            onFocus={() => nameQ && setShowDD(true)} style={{ paddingLeft: 36 }} />
          <svg style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", opacity: .3 }}
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          {searchLoading && <div style={{ position: "absolute", right: 12, top: "50%", marginTop: -8, width: 16, height: 16, border: "2px solid var(--green)", borderTopColor: "transparent", borderRadius: "50%", animation: "spin .6s linear infinite" }} />}
        </div>
        {showDD && searchResults.length > 0 && (
          <div ref={ddRef} className="dd">
            {searchResults.map(r => (
              <div key={r.symbol} className="ddi" onClick={() => handlePick(r.symbol, r.description)}>
                <span className="tbadge">{r.symbol}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--t1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.description}</div>
                  <div style={{ fontSize: 10, color: "var(--t3)" }}>{r.type}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "14px 0" }}>
        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
        <span style={{ fontSize: 10, color: "var(--t3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".12em" }}>or</span>
        <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
      </div>

      <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 5 }}>Enter Ticker Symbol</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="inp" placeholder="e.g. TSLA" value={tickerQ}
          onChange={e => setTickerQ(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === "Enter" && handleTickerGo()}
          style={{ flex: 1, textTransform: "uppercase", fontWeight: 700, letterSpacing: ".08em" }} />
        <button onClick={handleTickerGo} disabled={quoteLoading} style={{
          padding: "0 18px", borderRadius: 10,
          background: quoteLoading ? "var(--t3)" : "linear-gradient(135deg, var(--green), #00c28a)",
          border: "none", cursor: quoteLoading ? "wait" : "pointer",
          fontWeight: 700, fontSize: 13, color: "#060810", whiteSpace: "nowrap", fontFamily: "var(--font)",
        }}>{quoteLoading ? "..." : "Look Up"}</button>
      </div>
      {quoteError && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 6 }}>{quoteError}</div>}

      {selected && (
        <div style={{
          marginTop: 16, padding: "14px 18px", borderRadius: 14,
          background: "linear-gradient(135deg, rgba(0,229,160,.04), rgba(0,229,160,.01))",
          border: "1px solid rgba(0,229,160,.1)", animation: "fadeUp .3s ease-out",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 10, color: "var(--t3)", fontWeight: 700 }}>SELECTED</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 800, color: "var(--green)" }}>{selected.symbol}</span>
                <span style={{ fontSize: 11, color: "var(--t2)", maxWidth: 140, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{selected.name}</span>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 800, color: "var(--t1)" }}>${selected.price.toFixed(2)}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, color: selected.change >= 0 ? "var(--green)" : "var(--red)" }}>
                {selected.change >= 0 ? "+" : ""}{selected.change.toFixed(2)} ({selected.changePercent >= 0 ? "+" : ""}{selected.changePercent.toFixed(2)}%)
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 10, color: "var(--t3)" }}>
            <span>O: <b style={{ color: "var(--t2)" }}>${selected.open?.toFixed(2)}</b></span>
            <span>H: <b style={{ color: "var(--t2)" }}>${selected.high?.toFixed(2)}</b></span>
            <span>L: <b style={{ color: "var(--t2)" }}>${selected.low?.toFixed(2)}</b></span>
            <span>PC: <b style={{ color: "var(--t2)" }}>${selected.prevClose?.toFixed(2)}</b></span>
          </div>
          {selected.industry && <div style={{ fontSize: 10, color: "var(--t3)", marginTop: 4 }}>{selected.industry}{selected.marketCap ? ` · $${(selected.marketCap / 1000).toFixed(1)}B` : ""}</div>}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   PARAM INPUT
   ═══════════════════════════════════════════════════════════════════════════ */
function PInput({ label, value, onChange, prefix, suffix, step = 1, min = 0 }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 10, fontWeight: 700, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 5 }}>{label}</label>
      <div style={{ position: "relative" }}>
        {prefix && <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--t3)", fontSize: 14, fontWeight: 600, pointerEvents: "none" }}>{prefix}</span>}
        <input type="number" className="inp" value={value} onChange={e => onChange(parseFloat(e.target.value) || 0)}
          step={step} min={min} style={{ paddingLeft: prefix ? 28 : 14, paddingRight: suffix ? 44 : 14 }} />
        {suffix && <span style={{ position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)", color: "var(--t3)", fontSize: 11, fontWeight: 600, pointerEvents: "none" }}>{suffix}</span>}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   PNL CHART
   ═══════════════════════════════════════════════════════════════════════════ */
function PnLChart({ strategy, params, dte }) {
  const canvasRef = useRef(null);
  const [tip, setTip] = useState(null);
  const [dims, setDims] = useState({ w: 800, h: 400 });
  const { stockPrice } = params;
  const range = stockPrice * 0.4;
  const minP = Math.max(stockPrice - range, 0.01), maxP = stockPrice + range;
  const N = 250;
  const PAD = { t: 30, r: 30, b: 48, l: 72 };

  const slices = useMemo(() => {
    const cfgs = [
      { d: dte, label: `Today (${dte}d)`, color: "#6366f1", w: 2 },
      { d: Math.round(dte * .5), label: `${Math.round(dte * .5)}d`, color: "#fbbf24", w: 1.5 },
      { d: Math.round(dte * .2), label: `${Math.round(dte * .2)}d`, color: "#f97316", w: 1.5 },
      { d: 0, label: "Expiry", color: "#00e5a0", w: 2.5 },
    ];
    return cfgs.map(c => ({
      ...c,
      pts: Array.from({ length: N + 1 }, (_, i) => {
        const price = minP + (maxP - minP) * (i / N);
        return { price, pnl: computePnL(strategy, params, price, c.d) };
      }),
    }));
  }, [strategy, params, dte, minP, maxP]);

  const allPnl = slices.flatMap(s => s.pts.map(p => p.pnl));
  const rawMin = Math.min(...allPnl), rawMax = Math.max(...allPnl);
  const pad = (rawMax - rawMin) * .15 || 100;
  const yLo = rawMin - pad, yHi = rawMax + pad;

  const draw = useCallback(() => {
    const c = canvasRef.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    c.width = r.width * dpr; c.height = r.height * dpr;
    const ctx = c.getContext("2d"); ctx.scale(dpr, dpr);
    const W = r.width, H = r.height; setDims({ w: W, h: H });
    const cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;
    const toX = p => PAD.l + ((p - minP) / (maxP - minP)) * cw;
    const toY = v => PAD.t + (1 - (v - yLo) / (yHi - yLo)) * ch;

    ctx.clearRect(0, 0, W, H);
    ctx.font = "11px 'IBM Plex Mono'";
    for (let i = 0; i <= 5; i++) {
      const val = yLo + (yHi - yLo) * i / 5, y = toY(val);
      ctx.strokeStyle = "rgba(80,100,140,.06)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
      ctx.fillStyle = "rgba(122,139,168,.45)"; ctx.textAlign = "right";
      ctx.fillText(`${val >= 0 ? "+" : ""}$${val.toFixed(0)}`, PAD.l - 8, y + 4);
    }
    for (let i = 0; i <= 6; i++) {
      const val = minP + (maxP - minP) * i / 6, x = toX(val);
      ctx.strokeStyle = "rgba(80,100,140,.04)";
      ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, H - PAD.b); ctx.stroke();
      ctx.fillStyle = "rgba(122,139,168,.45)"; ctx.textAlign = "center";
      ctx.fillText(`$${val.toFixed(0)}`, x, H - PAD.b + 18);
    }
    if (yLo < 0 && yHi > 0) {
      const y0 = toY(0); ctx.strokeStyle = "rgba(122,139,168,.18)"; ctx.lineWidth = 1;
      ctx.setLineDash([8, 5]); ctx.beginPath(); ctx.moveTo(PAD.l, y0); ctx.lineTo(W - PAD.r, y0); ctx.stroke(); ctx.setLineDash([]);
    }
    const cpx = toX(stockPrice);
    ctx.strokeStyle = "rgba(122,139,168,.12)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(cpx, PAD.t); ctx.lineTo(cpx, H - PAD.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "rgba(122,139,168,.35)"; ctx.font = "10px 'IBM Plex Mono'"; ctx.textAlign = "center";
    ctx.fillText(`$${stockPrice.toFixed(2)}`, cpx, PAD.t - 8);

    const exp = slices[slices.length - 1], y0 = toY(0);
    for (let i = 0; i < exp.pts.length - 1; i++) {
      const a = exp.pts[i], b = exp.pts[i + 1], profit = (a.pnl + b.pnl) / 2 >= 0;
      ctx.fillStyle = profit ? "rgba(0,229,160,.05)" : "rgba(255,107,107,.035)";
      ctx.beginPath(); ctx.moveTo(toX(a.price), toY(a.pnl)); ctx.lineTo(toX(b.price), toY(b.pnl));
      ctx.lineTo(toX(b.price), y0); ctx.lineTo(toX(a.price), y0); ctx.closePath(); ctx.fill();
    }
    for (const s of slices) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.w; ctx.lineJoin = "round"; ctx.beginPath();
      s.pts.forEach((p, i) => { const x = toX(p.price), y = toY(p.pnl); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
      ctx.stroke();
    }
  }, [slices, stockPrice, minP, maxP, yLo, yHi]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => { const h = () => draw(); window.addEventListener("resize", h); return () => window.removeEventListener("resize", h); }, [draw]);

  const onMouse = (e) => {
    const r = canvasRef.current?.getBoundingClientRect(); if (!r) return;
    const mx = e.clientX - r.left, cw = r.width - PAD.l - PAD.r, rel = (mx - PAD.l) / cw;
    if (rel < 0 || rel > 1) { setTip(null); return; }
    const price = minP + rel * (maxP - minP), idx = Math.round(rel * N);
    setTip({ x: mx, y: e.clientY - r.top, price,
      lines: slices.map(s => ({ label: s.label, pnl: s.pts[Math.min(idx, s.pts.length - 1)].pnl, color: s.color })),
    });
  };

  return (
    <div style={{ position: "relative", width: "100%", height: 400 }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", cursor: "crosshair" }}
        onMouseMove={onMouse} onMouseLeave={() => setTip(null)} />
      <div style={{ position: "absolute", top: 6, right: 10, display: "flex", gap: 14, fontSize: 10, fontFamily: "var(--mono)" }}>
        {slices.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, color: s.color }}>
            <div style={{ width: 14, height: 3, background: s.color, borderRadius: 2 }} /><span style={{ fontWeight: 600 }}>{s.label}</span>
          </div>
        ))}
      </div>
      {tip && (
        <div style={{
          position: "absolute", left: Math.min(tip.x + 14, dims.w - 200), top: Math.max(tip.y - 16, 0),
          background: "rgba(6,8,16,.95)", border: "1px solid rgba(80,100,140,.2)", borderRadius: 12,
          padding: "10px 14px", fontSize: 11, fontFamily: "var(--mono)", color: "var(--t1)", pointerEvents: "none",
          zIndex: 20, minWidth: 180, backdropFilter: "blur(12px)", boxShadow: "0 12px 40px rgba(0,0,0,.4)",
        }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: "var(--t3)", fontSize: 10 }}>
            PRICE: <span style={{ color: "var(--t1)", fontSize: 12 }}>${tip.price.toFixed(2)}</span>
          </div>
          {tip.lines.map((l, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 2 }}>
              <span style={{ color: l.color, fontWeight: 500 }}>{l.label}</span>
              <span style={{ color: l.pnl >= 0 ? "var(--green)" : "var(--red)", fontWeight: 700 }}>
                {l.pnl >= 0 ? "+" : ""}${l.pnl.toFixed(0)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════════════════════ */
export default function OptionsLab() {
  const [apiKey, setApiKey] = useState("");
  const [strategy, setStrategy] = useState("long_put");
  const [selected, setSelected] = useState(null);
  const [strike, setStrike] = useState(170);
  const [premium, setPremium] = useState(3.50);
  const [contracts, setContracts] = useState(1);
  const [dte, setDte] = useState(30);
  const [iv, setIv] = useState(30);
  const [rfr, setRfr] = useState(5.0);

  const stockPrice = selected?.price || 0;
  const strat = STRATEGIES[strategy];
  const params = { strike, premium, contracts, stockPrice, iv, rfr };
  const n = contracts * 100;

  const summary = useMemo(() => {
    if (!stockPrice) return null;
    let mp, ml, be;
    if (strategy === "long_call") { mp = "∞"; ml = (premium * n).toFixed(2); be = (strike + premium).toFixed(2); }
    else if (strategy === "long_put") { mp = ((strike - premium) * n).toFixed(2); ml = (premium * n).toFixed(2); be = (strike - premium).toFixed(2); }
    else if (strategy === "covered_call") { mp = ((strike - stockPrice + premium) * n).toFixed(2); ml = ((stockPrice - premium) * n).toFixed(2); be = (stockPrice - premium).toFixed(2); }
    else { mp = (premium * n).toFixed(2); ml = ((strike - premium) * n).toFixed(2); be = (strike - premium).toFixed(2); }
    return { mp, ml, be, cur: computePnL(strategy, params, stockPrice, dte) };
  }, [strategy, stockPrice, strike, premium, n, dte, params]);

  const greeks = useMemo(() => {
    if (!stockPrice) return null;
    return bsGreeks(stockPrice, strike, dte / 365, rfr / 100, iv / 100, strategy.includes("call") ? "call" : "put");
  }, [stockPrice, strike, dte, iv, rfr, strategy]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", fontFamily: "var(--font)", color: "var(--t1)" }}>
      <style>{CSS}</style>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse 800px 600px at 15% 15%, rgba(0,229,160,.025), transparent), radial-gradient(ellipse 600px 400px at 85% 75%, rgba(99,102,241,.03), transparent)" }} />
      <div style={{ position: "fixed", inset: 0, zIndex: 1, pointerEvents: "none", opacity: .025,
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")` }} />

      <div style={{ position: "relative", zIndex: 2 }}>
        <header style={{
          padding: "14px 28px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          backdropFilter: "blur(16px)", background: "rgba(6,8,16,.7)", position: "sticky", top: 0, zIndex: 50,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: "linear-gradient(135deg, #00e5a0 0%, #00c28a 50%, #6366f1 100%)",
              backgroundSize: "200% 200%", animation: "gradShift 6s ease infinite",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 18, fontWeight: 900, color: "#060810", boxShadow: "0 4px 16px rgba(0,229,160,.2)",
            }}>Σ</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-.03em",
                background: "linear-gradient(135deg, var(--t1), var(--green))", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>OptionsLab</div>
              <div style={{ fontSize: 10, color: "var(--t3)", fontWeight: 500 }}>Real-Time Options Profit Calculator</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "var(--t3)", fontFamily: "var(--mono)" }}>
            Live data via <a href="https://finnhub.io" target="_blank" rel="noreferrer" style={{ color: "var(--green)", textDecoration: "none", fontWeight: 600 }}>Finnhub</a>
          </div>
        </header>

        <div style={{ maxWidth: 1320, margin: "0 auto", padding: "22px 28px", display: "grid", gridTemplateColumns: "310px 1fr", gap: 20 }}>
          <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <ApiKeyPanel apiKey={apiKey} setApiKey={setApiKey} />
            <StockSearch apiKey={apiKey} onSelect={s => { setSelected(s); setStrike(Math.round(s.price * .95)); }} selected={selected} />

            <div className="card" style={{ padding: "20px", animation: "fadeUp .6s ease-out" }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--t2)", marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: strat.accent, boxShadow: `0 0 10px ${strat.accent}` }} /> Strategy
              </h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
                {Object.entries(STRATEGIES).map(([k, s]) => (
                  <button key={k} className="sbtn" onClick={() => setStrategy(k)}
                    style={{ borderColor: strategy === k ? `${s.accent}50` : undefined, boxShadow: strategy === k ? `0 0 16px ${s.accent}12, inset 0 0 30px ${s.accent}05` : undefined }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                      <span style={{ fontSize: 14 }}>{s.icon}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: strategy === k ? s.accent : "var(--t1)" }}>{s.name}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "var(--t3)" }}>{s.tag}</div>
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 10, padding: "9px 12px", borderRadius: 10, background: `${strat.accent}06`, border: `1px solid ${strat.accent}15`, fontSize: 11, color: "var(--t2)", lineHeight: 1.5 }}>{strat.desc}</div>
            </div>

            <div className="card" style={{ padding: "20px", animation: "fadeUp .7s ease-out" }}>
              <h3 style={{ fontSize: 12, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--t2)", marginBottom: 12 }}>Parameters</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
                <PInput label="Strike Price" value={strike} onChange={setStrike} prefix="$" step={.5} />
                <PInput label="Option Premium" value={premium} onChange={setPremium} prefix="$" step={.05} />
                <PInput label="Contracts" value={contracts} onChange={setContracts} step={1} min={1} />
                <PInput label="Days to Expiry" value={dte} onChange={setDte} suffix="days" step={1} min={0} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <PInput label="IV" value={iv} onChange={setIv} suffix="%" step={1} min={1} />
                  <PInput label="Risk-Free" value={rfr} onChange={setRfr} suffix="%" step={.25} />
                </div>
              </div>
            </div>
          </aside>

          <main style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {!selected ? (
              <div className="card" style={{ padding: "70px 36px", textAlign: "center", animation: "fadeUp .4s ease-out" }}>
                <div style={{ fontSize: 42, marginBottom: 12, opacity: .2 }}>📈</div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "var(--t2)", marginBottom: 6 }}>Select a Stock to Begin</div>
                <div style={{ fontSize: 12, color: "var(--t3)", maxWidth: 360, margin: "0 auto", lineHeight: 1.6 }}>
                  {apiKey ? "Search by company name or enter a ticker in the left panel to load live pricing data." : "Start by entering your free Finnhub API key above, then search for any US-listed stock."}
                </div>
              </div>
            ) : summary && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, animation: "fadeUp .4s ease-out" }}>
                  {[
                    { l: "Max Profit", v: summary.mp === "∞" ? "∞" : `$${summary.mp}`, c: "var(--green)" },
                    { l: "Max Loss", v: `$${summary.ml}`, c: "var(--red)" },
                    { l: "Breakeven", v: `$${summary.be}`, c: "var(--amber)" },
                    { l: "Current P&L", v: `${summary.cur >= 0 ? "+" : ""}$${summary.cur.toFixed(2)}`, c: summary.cur >= 0 ? "var(--green)" : "var(--red)" },
                  ].map((s, i) => (
                    <div key={i} className="card" style={{ padding: "13px 15px" }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 4 }}>{s.l}</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: s.c, fontFamily: "var(--mono)" }}>{s.v}</div>
                    </div>
                  ))}
                </div>

                {greeks && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8, animation: "fadeUp .5s ease-out" }}>
                    {[
                      { l: "Delta", v: greeks.delta.toFixed(4), c: "#6366f1" },
                      { l: "Gamma", v: greeks.gamma.toFixed(6), c: "#8b5cf6" },
                      { l: "Theta", v: greeks.theta.toFixed(4), c: "#f97316" },
                      { l: "Vega", v: greeks.vega.toFixed(4), c: "#06b6d4" },
                      { l: "Rho", v: greeks.rho.toFixed(4), c: "#ec4899" },
                    ].map((g, i) => (
                      <div key={i} style={{ padding: "9px 11px", borderRadius: 11, background: "var(--card)", border: "1px solid var(--border)" }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: g.c, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 3 }}>{g.l}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--mono)", color: "var(--t1)" }}>{g.v}</div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="card" style={{ padding: "20px 16px 12px", animation: "fadeUp .6s ease-out" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--t2)" }}>P&L — <span style={{ color: strat.accent }}>{strat.name}</span></div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 7, background: "rgba(99,102,241,.08)", color: "#818cf8" }}>
                      {selected.symbol} @ ${stockPrice.toFixed(2)}
                    </div>
                  </div>
                  <PnLChart strategy={strategy} params={params} dte={dte} />
                </div>

                <div className="card" style={{ padding: "16px", overflowX: "auto", animation: "fadeUp .7s ease-out" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--t2)", marginBottom: 10 }}>P&L at Expiration</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border)" }}>
                        {["Stock Price", "P&L/Share", "Total P&L", "Return %"].map(h => (
                          <th key={h} style={{ textAlign: h === "Stock Price" ? "left" : "right", padding: "7px 10px", color: "var(--t3)", fontWeight: 700, fontSize: 9, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: 11 }, (_, i) => {
                        const step = stockPrice * .05;
                        const price = Math.max(stockPrice - step * 5 + step * i, 0.01);
                        const total = computePnL(strategy, params, price, 0);
                        const ps = total / n, basis = premium * n;
                        const pct = basis > 0 ? (total / basis) * 100 : 0;
                        const cur = Math.abs(price - stockPrice) < step * .3;
                        return (
                          <tr key={i} style={{ borderBottom: "1px solid rgba(80,100,140,.04)", background: cur ? "rgba(0,229,160,.03)" : "transparent" }}>
                            <td style={{ padding: "7px 10px", color: cur ? "var(--green)" : "var(--t1)", fontWeight: cur ? 700 : 500 }}>${price.toFixed(2)}{cur && " ◄"}</td>
                            <td style={{ textAlign: "right", padding: "7px 10px", color: ps >= 0 ? "var(--green)" : "var(--red)" }}>{ps >= 0 ? "+" : ""}{ps.toFixed(2)}</td>
                            <td style={{ textAlign: "right", padding: "7px 10px", color: total >= 0 ? "var(--green)" : "var(--red)", fontWeight: 700 }}>{total >= 0 ? "+" : ""}${total.toFixed(2)}</td>
                            <td style={{ textAlign: "right", padding: "7px 10px", color: pct >= 0 ? "var(--green)" : "var(--red)" }}>{pct >= 0 ? "+" : ""}{pct.toFixed(1)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
