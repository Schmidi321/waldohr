// Winziger statischer Dev-Server (keine Abhängigkeiten).
// Start:  node scripts/serve.mjs        ->  http://localhost:8080
//         PORT=3000 node scripts/serve.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // -> waldohr/
const PORT = process.env.PORT || 8080;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon'
};

http.createServer(async (req, res) => {
  let f = decodeURIComponent(req.url.split('?')[0]);
  if (f === '/') f = '/index.html';
  const fp = path.join(root, f);
  if (!fp.startsWith(root)) { res.writeHead(403); return res.end('403'); }
  try {
    const data = await readFile(fp);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(fp)] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('404 – ' + f);
  }
}).listen(PORT, () => console.log(`Waldohr laeuft auf http://localhost:${PORT}  (Strg+C zum Beenden)`));
