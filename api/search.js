module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { q } = req.query;
  if (!q) return res.status(200).json({ results: [] });

  const key = process.env.FINNHUB_API_KEY;
  if (!key) return res.status(500).json({ error: 'API not configured' });

  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${key}`
    );
    if (!r.ok) return res.status(502).json({ error: 'Upstream search error' });

    const data = await r.json();
    const results = (data.result || [])
      .filter(x => ['Common Stock', 'ETP', 'ADR', 'ETF'].includes(x.type))
      .filter(x => !x.symbol.includes('.'))
      .slice(0, 8)
      .map(x => ({ symbol: x.symbol, description: x.description, type: x.type }));

    return res.status(200).json({ results });
  } catch (err) {
    console.error('search error', err);
    return res.status(500).json({ error: 'Search failed' });
  }
};
