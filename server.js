const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Load .env.local if present (for local dev)
try {
  const env = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8');
  env.split('\n').forEach(line => {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
  });
} catch {}

const port = process.env.PORT || 8080;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Route /api/* to handler files
  if (pathname.startsWith('/api/')) {
    const name = pathname.replace('/api/', '').split('/')[0];
    const handlerPath = path.join(__dirname, 'api', name + '.js');
    if (fs.existsSync(handlerPath)) {
      // Build a minimal req/res compatible with Vercel handler signature
      req.query = parsed.query;
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      res.end = res.end.bind(res);
      try {
        const handler = require(handlerPath);
        await handler(req, res);
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'API route not found' }));
    return;
  }

  // Serve static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
    } else {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(data);
    }
  });

}).listen(port, () => console.log(`Serving at http://localhost:${port}`));
