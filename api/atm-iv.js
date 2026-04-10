// Returns ATM implied volatility for the nearest expiration using MarketData.app.
// Used to auto-populate the IV field when a stock is looked up.
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, price } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const token = process.env.MARKETDATA_TOKEN;
  if (!token) return res.status(500).json({ error: 'Market Data API not configured' });

  const headers = { Authorization: `Token ${token}` };
  const stockPrice = parseFloat(price) || 0;

  try {
    // 1. Fetch expirations
    const expR = await fetch(
      `https://api.marketdata.app/v1/options/expirations/${encodeURIComponent(symbol)}/`,
      { headers }
    );
    if (!expR.ok) return res.status(502).json({ error: 'Could not fetch expirations' });
    const expData = await expR.json();
    if (expData.s !== 'ok' || !expData.expirations?.length) {
      return res.status(404).json({ error: 'No expirations available' });
    }

    // Pick the nearest expiration that is at least 7 days out (for meaningful IV)
    const today = new Date();
    const nearExp = expData.expirations.find(e => {
      const d = new Date(e);
      return (d - today) / 86400000 >= 7;
    }) || expData.expirations[0];

    // 2. Fetch chain for that expiration
    const chainR = await fetch(
      `https://api.marketdata.app/v1/options/chain/${encodeURIComponent(symbol)}/?expiration=${nearExp}`,
      { headers }
    );
    if (!chainR.ok) return res.status(502).json({ error: 'Could not fetch chain' });
    const chainData = await chainR.json();
    if (chainData.s !== 'ok') return res.status(502).json({ error: 'Chain error' });

    // Find ATM strike (closest to current price)
    const strikes = [...new Set(chainData.strike || [])].sort((a, b) => a - b);
    if (!strikes.length) return res.status(404).json({ error: 'No strikes available' });

    const atmStrike = strikes.reduce((closest, s) =>
      Math.abs(s - stockPrice) < Math.abs(closest - stockPrice) ? s : closest
    , strikes[0]);

    // Average IV of ATM call + put
    const atmIVs = (chainData.optionSymbol || [])
      .map((_, i) => ({
        strike: chainData.strike?.[i],
        iv:     chainData.impliedVolatility?.[i],
      }))
      .filter(c => c.strike === atmStrike && c.iv != null && c.iv > 0.001);

    if (!atmIVs.length) return res.status(404).json({ error: 'No ATM IV available' });

    const avgIV = atmIVs.reduce((sum, c) => sum + c.iv, 0) / atmIVs.length;

    return res.status(200).json({
      iv:         avgIV,
      strike:     atmStrike,
      expiration: nearExp,
    });
  } catch (err) {
    console.error('atm-iv error', err);
    return res.status(500).json({ error: err.message });
  }
};
