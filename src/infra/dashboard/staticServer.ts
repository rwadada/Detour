import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serves the built dashboard SPA (`web-dist/`, built from `web/`) as static
 * files, falling back to `index.html` for any extensionless GET so
 * client-side routes (should the dashboard ever grow beyond one screen)
 * survive a hard refresh. Deliberately dependency-free — the dashboard is
 * one small, static bundle, not worth pulling in a static-file-server
 * package for.
 */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  // `decodeURIComponent` throws a `URIError` (synchronously) on a malformed
  // percent-encoding (e.g. `/%`, `/%zz`) — this runs unauthenticated, ahead
  // of the dashboard password gate, so a single malformed request must not
  // be able to crash the whole process (issue #94). Treated the same as the
  // traversal guard below: 400 Bad Request, not a 500 or an uncaught throw.
  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  const hasExtension = path.extname(requestedPath) !== '';
  const relative = requestedPath === '/' ? 'index.html' : requestedPath.replace(/^\/+/, '');

  // Resolve within `root` and reject any path (e.g. via `..`) that escapes it.
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const fallbackToIndex = () => {
    if (hasExtension) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    sendFile(path.join(root, 'index.html'), req, res, true);
  };

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) return fallbackToIndex();
    sendFile(resolved, req, res, false);
  });
}

function sendFile(filePath: string, req: IncomingMessage, res: ServerResponse, isFallback: boolean): void {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(isFallback ? 500 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(isFallback ? 'Dashboard build not found (run `npm run build`)' : 'Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    // index.html references hashed asset filenames, so it must never be
    // cached — otherwise a rebuilt dashboard can end up pointing at assets
    // that no longer exist.
    const cacheControl = ext === '.html' ? 'no-store' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}
