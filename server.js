const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const scanner = require('./scan');

const PORT = +process.env.PORT || 4321;
const PAGE = path.join(__dirname, 'public', 'index.html');
const OPENER = { win32: 'explorer.exe', darwin: 'open' }[process.platform] || 'xdg-open';
const known = p => scanner.state.repos.find(r => r.path === p);

const json = (res, data, code = 200) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data));
const readBody = req => new Promise(resolve => {
  let s = '';
  req.on('data', c => { s += c; }).on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } });
});

http.createServer(async (req, res) => {
  // Only answer our own origin: blocks DNS rebinding, and the JSON content-type forces a CORS preflight cross-site.
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return json(res, { error: 'forbidden' }, 403);

  if (req.method === 'GET' && req.url === '/') {
    return fs.createReadStream(PAGE).pipe(res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }));
  }
  if (req.method === 'GET' && req.url === '/api/state') return json(res, scanner.state);

  if (req.method === 'POST') {
    if (req.headers['content-type'] !== 'application/json') return json(res, { error: 'json only' }, 415);
    if (req.url === '/api/scan') {
      scanner.scan();
      return json(res, { ok: true });
    }
    if (req.url === '/api/open') {
      const { path: p } = await readBody(req);
      if (!known(p)) return json(res, { error: 'unknown repo' }, 404);
      execFile(OPENER, [p], () => {}); // explorer.exe exits 1 even on success
      return json(res, { ok: true });
    }
    if (req.url === '/api/refresh') {
      const { path: p } = await readBody(req);
      if (!known(p)) return json(res, { error: 'unknown repo' }, 404);
      await scanner.refresh(p);
      return json(res, { ok: true });
    }
  }
  json(res, { error: 'not found' }, 404);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`RepoRadar → http://localhost:${PORT}`);
  scanner.load();
  if (!scanner.state.finishedAt) scanner.scan();
});
