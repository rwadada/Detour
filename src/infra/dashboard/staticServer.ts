import crypto from 'node:crypto';
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
  const stripped = requestedPath.replace(/^\/+/, '');
  const relative = stripped === '' ? 'index.html' : stripped;

  // Resolve within `root` and reject any path (e.g. via `..`) that escapes it.
  const rootDir = path.resolve(root);
  const resolved = path.resolve(rootDir, relative);
  if (!resolved.startsWith(rootDir + path.sep)) {
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
    sendFile(path.join(rootDir, 'index.html'), req, res, true);
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
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      ...(ext === '.html' ? { 'Content-Security-Policy': dashboardCsp(data.toString('utf8'), req.headers.host) } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/**
 * The dashboard page's Content-Security-Policy — defence in depth for a page
 * that renders traffic from arbitrary servers: no script but the bundle and
 * the page's own inline ones (pinned by hash), no plugins, no framing, no
 * base-URI tricks. (Captured SVGs are kept off the dashboard's origin by
 * previewing them as `data:` URLs — see `BodyViewer.tsx`; a CSP alone
 * doesn't cover a `blob:` opened in a tab of its own.)
 *
 * `'unsafe-eval'` is there for protobufjs, which the gRPC body decoder uses
 * and which builds its decoders with `Function(...)`; it doesn't let markup
 * run script. Inline style stays allowed (React and Tailwind attribute
 * styles), which can't run code either. `connect-src` names the WebSocket
 * origin explicitly, since older WebKit doesn't match `ws:`/`wss:` against
 * `'self'`.
 */
export function dashboardCsp(html: string, host?: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) =>
      `'sha256-${crypto
        .createHash('sha256')
        .update(m[1] ?? '', 'utf8')
        .digest('base64')}'`,
  );
  // The Host header already passed the dashboard's allowlist; this only keeps
  // anything but a host[:port] out of the header value.
  const wsOrigins = host && /^[A-Za-z0-9.:[\]-]+$/.test(host) ? ` ws://${host} wss://${host}` : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-eval' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    `connect-src 'self'${wsOrigins}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
