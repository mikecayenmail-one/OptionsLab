module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, mode, expiration } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const token = process.env.MARKETDATA_TOKEN;
  if (!token) return res.status(500).json({ error: 'Market Data API not configured' });

  const headers = { Authorization: `Token ${token}` };

  try {
    /* ── Expirations ── */
    if (mode === 'expirations') {
      const r = await fetch(
        `https://api.marketdata.app/v1/options/expirations/${encodeURIComponent(symbol)}/`,
        { headers }
      );
      if (!r.ok) return res.status(502).json({ error: 'Could not fetch expirations' });
      const data = await r.json();
      if (data.s !== 'ok') return res.status(502).json({ error: data.errmsg || 'Expirations error' });
      return res.status(200).json({ expirations: data.expirations });
    }

    /* ── Options chain for one expiration ── */
    if (mode === 'chain') {
      if (!expiration) return res.status(400).json({ error: 'expiration required' });
      const r = await fetch(
        `https://api.marketdata.app/v1/options/chain/${encodeURIComponent(symbol)}/?expiration=${expiration}`,
        { headers }
      );
      if (!r.ok) return res.status(502).json({ error: 'Could not fetch options chain' });
      const data = await r.json();
      if (data.s !== 'ok') return res.status(502).json({ error: data.errmsg || 'Chain error' });

      // Zip columnar arrays → per-contract objects
      const contracts = (data.optionSymbol || []).map((sym, i) => ({
        symbol:   sym,
        strike:   data.strike?.[i],
        side:     data.side?.[i],
        bid:      data.bid?.[i]              ?? null,
        mid:      data.mid?.[i]              ?? null,
        ask:      data.ask?.[i]              ?? null,
        last:     data.last?.[i]             ?? null,
        volume:   data.volume?.[i]           ?? null,
        oi:       data.openInterest?.[i]     ?? null,
        iv:       data.impliedVolatility?.[i]?? null,
        delta:    data.delta?.[i]            ?? null,
        gamma:    data.gamma?.[i]            ?? null,
        theta:    data.theta?.[i]            ?? null,
        vega:     data.vega?.[i]             ?? null,
        dte:      data.dte?.[i]              ?? null,
      }));

      // Group by strike — pair call + put per row
      const byStrike = {};
      contracts.forEach(c => {
        if (!byStrike[c.strike]) byStrike[c.strike] = { strike: c.strike, dte: c.dte };
        byStrike[c.strike][c.side] = c;
      });
      const rows = Object.values(byStrike).sort((a, b) => a.strike - b.strike);

      return res.status(200).json({ s: 'ok', rows, dte: data.dte?.[0] ?? null });
    }

    return res.status(400).json({ error: 'mode must be "expirations" or "chain"' });

  } catch (err) {
    console.error('options error', err);
    return res.status(500).json({ error: err.message });
  }
};
