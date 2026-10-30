import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readHistory } from './history.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export function dashboardHandler({ directory, port, runtime = () => ({ connected: false }), submit }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const host = `127.0.0.1:${typeof port === 'function' ? port() : port}`;
    const origin = `http://${host}`;
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end('Local dashboard access only.'); return;
    }
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'POST' && path === '/api/message') {
        res.setHeader('Content-Type', 'application/json');
        if (req.headers.origin !== origin || req.headers['x-bridge-request'] !== '1' || req.headers['content-type'] !== 'application/json') {
          res.writeHead(403).end(JSON.stringify({ error: 'Send messages from the local dashboard.' })); return;
        }
        if (!submit) { res.writeHead(503).end(JSON.stringify({ error: 'Archive mode. Start the bridge with npm start to send messages.' })); return; }
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 16384) { res.writeHead(413).end(JSON.stringify({ error: 'Message is too long.' })); return; }
        }
        let data;
        try { data = JSON.parse(body); } catch { res.writeHead(400).end(JSON.stringify({ error: 'Invalid message.' })); return; }
        if (!data || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 8000 || typeof data.conversationId !== 'string') {
          res.writeHead(400).end(JSON.stringify({ error: 'Choose a conversation and enter a message of up to 8,000 characters.' })); return;
        }
        try { res.end(JSON.stringify(await submit(data))); }
        catch (error) { res.writeHead(error.status || 500).end(JSON.stringify({ error: error.status ? error.message : 'Could not submit the message. Check the bridge terminal before retrying.' })); }
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
      if (path === '/api/history') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...readHistory(directory), runtime: runtime() })); return;
      }
      const asset = assets.get(path);
      if (!asset) { res.writeHead(404).end('Not found'); return; }
      res.setHeader('Content-Type', asset[1]);
      res.end(readFileSync(new URL(`../web/${asset[0]}`, import.meta.url)));
    } catch { res.writeHead(500).end('Unable to read conversation history. Check the bridge terminal.'); }
  };
}

export async function startDashboard({ directory = resolve('.bridge'), port = Number(process.env.DASHBOARD_PORT || 8787), runtime = () => ({ connected: false }), submit } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('DASHBOARD_PORT must be a valid port number.');
  const server = createServer(dashboardHandler({ directory, port: () => server.address().port, runtime, submit }));
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolvePromise); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDashboard().then(server => {
    console.log(`Conversation archive: http://127.0.0.1:${server.address().port}\nRead-only viewer. To record new messages, run npm start instead.`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
  }).catch(error => { console.error(error.code === 'EADDRINUSE' ? 'Dashboard already running on this port. Open its URL, or set DASHBOARD_PORT to another port.' : error.message); process.exitCode = 1; });
}
