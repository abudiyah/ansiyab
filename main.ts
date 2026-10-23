import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { config } from './config.ts';
import { createApi, HttpError } from './api.ts';
import { Ingestor } from './ingest.ts';
import { Store } from './store.ts';

const store = new Store(config.dataDir);
store.load(config.regionId);
const ingestor = new Ingestor(store);
const api = createApi(store, ingestor);

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body, (_k, v) => (v === Infinity ? null : v)));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 100_000) throw new HttpError(413, 'الطلب كبير');
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    throw new HttpError(400, 'JSON غير صالح');
  }
}

/** وكيل بلاطات TomTom: يبقي المفتاح في الخادم */
async function tomtomTile(res: ServerResponse, z: string, x: string, y: string) {
  if (!config.tomtomKey || !config.tomtomRasterTiles) return send(res, 404, { error: 'TomTom غير مفعّل' });
  const url = `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?key=${encodeURIComponent(config.tomtomKey)}&tileSize=256`;
  const r = await fetch(url);
  if (!r.ok) {
    store.markError('tomtom-flow', 900, `tiles HTTP ${r.status}`);
    return send(res, r.status, { error: `TomTom ${r.status}` });
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=60', ...SECURITY_HEADERS });
  res.end(Buffer.from(await r.arrayBuffer()));
}

function serveStatic(res: ServerResponse, path: string) {
  if (!existsSync(config.webDist)) return send(res, 404, { error: 'لم تُبنَ الواجهة: شغّل npm run build' });
  let file = normalize(join(config.webDist, path));
  if (!file.startsWith(config.webDist)) return send(res, 403, { error: 'ممنوع' });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(config.webDist, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'max-age=31536000, immutable' : 'no-cache', ...SECURITY_HEADERS });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    const tile = url.pathname.match(/^\/api\/tiles\/tomtom\/flow\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (tile) return await tomtomTile(res, tile[1]!, tile[2]!, tile[3]!);
    if (url.pathname.startsWith('/api/')) {
      const body = await readBody(req);
      const out = await api({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body, headers: req.headers });
      return send(res, 200, out);
    }
    serveStatic(res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 502, { error: e instanceof Error ? e.message : 'خطأ' });
  }
});

server.listen(config.port, () => {
  console.log(`منصة انسياب: http://localhost:${config.port}  (الوضع: ${config.mode === 'simulation' ? 'محاكاة' : 'حي'})`);
  void ingestor.start();
});

process.on('SIGINT', () => {
  ingestor.stop();
  store.saveAlerts();
  process.exit(0);
});
