const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const scanner = require('./scan');

const PORT = +process.env.PORT || 4321;
const PAGE = path.join(__dirname, 'public', 'index.html');
const OPENER = { win32: 'explorer.exe', darwin: 'open' }[process.platform] || 'xdg-open';
const known = p => scanner.state.repos.find(r => r.path === p);

// On Windows `code` is code.cmd, which Node can only run through cmd.exe, and cmd.exe would interpret `&`, `^`, `%`
// in folder names. Run Code.exe (next to bin\) directly instead, the same thing Explorer's "Open with Code" does.
const findVSCode = () => new Promise(resolve => {
  if (process.platform !== 'win32') return resolve('code');
  execFile('where', ['code.cmd'], { windowsHide: true }, (err, out) => {
    const exe = err ? null : path.resolve(path.dirname(out.split(/\r?\n/)[0]), '..', 'Code.exe');
    resolve(exe && fs.existsSync(exe) ? exe : null);
  });
});

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
    if (req.url === '/api/code') {
      const { path: p } = await readBody(req);
      if (!known(p)) return json(res, { error: 'unknown repo' }, 404);
      const exe = await findVSCode();
      if (!exe) return json(res, { error: 'VS Code not found on PATH' }, 404);
      const { ELECTRON_RUN_AS_NODE, ...env } = process.env; // would make Code.exe run as plain Node
      const child = spawn(exe, [p], { detached: true, stdio: 'ignore', env });
      const ok = await new Promise(r => child.once('spawn', () => r(true)).once('error', () => r(false)));
      child.unref();
      return ok ? json(res, { ok: true }) : json(res, { error: 'could not start VS Code' }, 500);
    }
    if (req.url === '/api/refresh') {
      const { path: p } = await readBody(req);
      if (!known(p)) return json(res, { error: 'unknown repo' }, 404);
      await scanner.refresh(p);
      return json(res, { ok: true });
    }
    if (req.url === '/api/clean') {
      // Deletes files: only a build folder the scan itself reported for a known repo, and never through a link.
      const { path: p, name } = await readBody(req);
      if (!known(p)?.buildDirs?.some(d => d.name === name)) return json(res, { error: 'unknown build folder' }, 404);
      const target = path.join(p, name);
      try {
        if (!fs.lstatSync(target).isDirectory()) return json(res, { error: 'not a plain folder' }, 400);
        await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 2 });
      } catch (e) {
        await scanner.refresh(p); // a partial delete still changed the size
        return json(res, { error: e.code === 'ENOENT' ? 'already gone' : `delete failed: ${e.code || e.message}` }, 500);
      }
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
