module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });

  const key = process.env.FINNHUB_API_KEY;
  if (!key) return res.status(500).json({ error: 'API not configured' });

  try {
    const [qr, pr] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`),
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`),
    ]);

    if (!qr.ok) return res.status(502).json({ error: 'Upstream quote error' });

    const [q, p] = await Promise.all([qr.json(), pr.json()]);

    if (!q.c || q.c === 0) {
      return res.status(404).json({ error: `No price data for ${symbol}. Check the ticker.` });
    }

    return res.status(200).json({
      symbol:       symbol.toUpperCase(),
      name:         p.name         || symbol,
      price:        q.c,
      change:       q.d            || 0,
      changePct:    q.dp           || 0,
      high:         q.h,
      low:          q.l,
      open:         q.o,
      prevClose:    q.pc,
      industry:     p.finnhubIndustry        || null,
      cap:          p.marketCapitalization   || null,
    });
  } catch (err) {
    console.error('quote error', err);
    return res.status(500).json({ error: 'Failed to fetch quote' });
  }
};
