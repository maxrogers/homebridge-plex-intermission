import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
const pub = new URL('../../homebridge-ui/public/', import.meta.url).pathname;
const here = new URL('.', import.meta.url).pathname;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const file = url.startsWith('/public/') ? join(pub, url.slice(8)) : url === '/bootstrap.css' ? join(here, 'node_modules/bootstrap/dist/css/bootstrap.min.css') : join(here, 'harness.html');
  try { res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'text/plain' }).end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
}).listen(8765);
