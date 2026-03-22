/**
 * Stashwise – API proxy server
 * Keeps Anthropic + ElevenLabs keys server-side only.
 */
'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT           = process.env.PORT || 3000;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY  || '';
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY  || '';

if (!ANTHROPIC_KEY)  console.warn('[WARN] ANTHROPIC_KEY env var not set');
if (!ELEVENLABS_KEY) console.warn('[WARN] ELEVENLABS_KEY env var not set');

/* Work out where public/ is — try __dirname first, then cwd */
const PUBLIC_DIR = (function() {
  const candidates = [
    path.resolve(__dirname, 'public'),
    path.resolve(process.cwd(), 'public'),
  ];
  for (const d of candidates) {
    if (fs.existsSync(d)) {
      console.log('[Stashwise] Serving static files from:', d);
      return d;
    }
  }
  console.error('[ERROR] Could not find public/ directory. Checked:', candidates);
  return candidates[0]; // fallback — will 404 gracefully
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

/* ── Proxy helpers ── */
function proxyJSON(req, res, targetHost, targetPath, extraHeaders) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const options = {
      hostname: targetHost,
      path: targetPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders,
      },
    };
    const proxy = https.request(options, upstream => {
      res.writeHead(upstream.statusCode, {
        'Content-Type': upstream.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      upstream.pipe(res);
    });
    proxy.on('error', err => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }));
    });
    proxy.write(body);
    proxy.end();
  });
}

function proxyBinary(req, res, targetHost, targetPath, extraHeaders) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const options = {
      hostname: targetHost,
      path: targetPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...extraHeaders,
      },
    };
    const proxy = https.request(options, upstream => {
      res.writeHead(upstream.statusCode, {
        'Content-Type': upstream.headers['content-type'] || 'audio/mpeg',
        'Access-Control-Allow-Origin': '*',
      });
      upstream.pipe(res);
    });
    proxy.on('error', err => {
      res.writeHead(502);
      res.end();
    });
    proxy.write(body);
    proxy.end();
  });
}

function proxyMultipart(req, res, targetHost, targetPath, extraHeaders) {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    const options = {
      hostname: targetHost,
      path: targetPath,
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'],
        'Content-Length': bodyBuf.length,
        ...extraHeaders,
      },
    };
    const proxy = https.request(options, upstream => {
      res.writeHead(upstream.statusCode, {
        'Content-Type': upstream.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      upstream.pipe(res);
    });
    proxy.on('error', err => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    proxy.write(bodyBuf);
    proxy.end();
  });
}

/* ── Main server ── */
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);
  const pathname  = parsedUrl.pathname;

  /* CORS preflight */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  /* ── API routes ── */
  if (req.method === 'POST' && pathname === '/api/claude') {
    return proxyJSON(req, res, 'api.anthropic.com', '/v1/messages', {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    });
  }

  if (req.method === 'POST' && pathname.startsWith('/api/tts/')) {
    const voiceId = pathname.replace('/api/tts/', '');
    return proxyBinary(req, res, 'api.elevenlabs.io', '/v1/text-to-speech/' + voiceId, {
      'xi-api-key': ELEVENLABS_KEY,
    });
  }

  if (req.method === 'POST' && pathname === '/api/stt') {
    return proxyMultipart(req, res, 'api.elevenlabs.io', '/v1/speech-to-text', {
      'xi-api-key': ELEVENLABS_KEY,
    });
  }

  /* ── Static file serving ── */
  if (req.method === 'GET') {
    /* Normalise: strip query string, default to index.html */
    let clean = pathname.split('?')[0];
    if (clean === '/' || clean === '') clean = 'index.html';
    else clean = clean.replace(/^\//, ''); /* strip leading slash */

    const filePath = path.join(PUBLIC_DIR, clean);

    /* Path traversal guard */
    if (!path.resolve(filePath).startsWith(path.resolve(PUBLIC_DIR))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        console.error('[404]', filePath, err.code);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found: ' + clean);
      }
      const ext  = path.extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log('[Stashwise] Server running on port ' + PORT);
  console.log('[Stashwise] PUBLIC_DIR:', PUBLIC_DIR);
  console.log('[Stashwise] __dirname:', __dirname);
  console.log('[Stashwise] cwd:', process.cwd());
});
