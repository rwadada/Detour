import { compactHeaders } from '../exchange/headers';
import type { CapturedExchange } from '../exchange/types';
import type { Fixture } from './types';

/**
 * Headers whose recorded value would be wrong (or actively break replay)
 * once served back by a different server (`detour serve`, not the original
 * one) than the one that sent them. Exported so `detour serve` (`cli.ts`)
 * can strip them again defensively at serve time too — a hand-edited
 * fixture (or one written by something other than `detour record`) could
 * reintroduce one even though recording already drops it here.
 */
export const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'transfer-encoding',
  'content-length',
  'keep-alive',
  // The rest of RFC 7230's hop-by-hop set, plus `proxy-connection` — a
  // non-standard but common header some servers/proxies still send. The
  // proxy engine itself already strips `proxy-connection`/`upgrade` from a
  // captured response for the same reason (see `proxyEngine.ts`): none of
  // these describe the connection `detour serve` itself makes to a client,
  // so re-emitting a recorded value here would be meaningless at best.
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
]);

function splitUrl(url: string): { pathname: string; path: string } {
  try {
    const parsed = new URL(url);
    return { pathname: parsed.pathname, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    // A malformed/relative `exchange.url` shouldn't normally happen (see
    // its own doc comment: "Fully-qualified URL") — but if it does, a bare
    // `new URL()` fails on a relative string like "orders/1" too. Retrying
    // against a throwaway base still recovers the pathname/query in that
    // case; only a truly unparseable string falls through to the raw-string
    // fallback below.
    try {
      const parsed = new URL(url, 'https://(unparseable-exchange-url)');
      return { pathname: parsed.pathname, path: `${parsed.pathname}${parsed.search}` };
    } catch {
      // Keeps this a total function instead of throwing over a single odd
      // exchange in the middle of a recording run — and still satisfies
      // `loadFixtureFiles`'s "path must start with /" invariant, so this
      // fixture can at least be loaded and (fail to) match later instead of
      // being permanently unloadable.
      const path = url.startsWith('/') ? url : `/${url}`;
      return { pathname: path, path };
    }
  }
}

/**
 * Keeps a fixture filename filesystem-safe and reasonably short on any OS,
 * while still being recognizable from the endpoint it came from. Trims
 * leading/trailing dashes with two separate single-quantifier replaces
 * rather than one `/^-+|-+$/` — an alternation of two unbounded quantifiers
 * over the same character is a classic catastrophic-backtracking shape.
 */
function slugify(pathname: string, maxLength = 40): string {
  const cleaned = pathname
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+/, '')
    // Bounded (not `/-+$/`, an unbounded quantifier anchored right up
    // against `$`) — same catastrophic-backtracking shape as before, just
    // with only one alternative instead of two. `pathname` is already far
    // shorter than this in practice; the bound only needs to comfortably
    // cover it.
    .replace(/-{1,256}$/, '');
  return cleaned.slice(0, maxLength) || 'root';
}

export interface BuiltFixture {
  fixture: Fixture;
  filename: string;
}

/**
 * Converts one captured HTTP exchange into a replayable fixture for
 * `detour record` (issue #149). `sequence` becomes a zero-padded filename
 * prefix, which is what lets `loadFixtureFiles` recover recording order
 * later just by sorting filenames — `FixtureStore`'s round-robin replay
 * (multiple recordings of the same endpoint, e.g. pagination, replayed in
 * the order they were recorded) depends on that order surviving the
 * write-then-reload round trip.
 */
export function buildFixtureFromExchange(exchange: CapturedExchange, sequence: number): BuiltFixture {
  const { pathname, path } = splitUrl(exchange.url);

  // `compactHeaders`, not `flattenHeaders` — the latter comma-joins a
  // multi-value header (e.g. more than one `Set-Cookie`), which is exactly
  // wrong here: `detour serve` re-emits `responseHeaders` onto a real
  // response later, and a comma-joined `Set-Cookie` is not a valid way to
  // send more than one cookie (each must stay on its own header line).
  const responseHeaders = compactHeaders(exchange.responseHeaders ?? {});
  for (const key of Object.keys(responseHeaders)) {
    if (DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) delete responseHeaders[key];
  }

  const fixture: Fixture = {
    method: exchange.method,
    path,
    status: exchange.statusCode ?? 200,
    responseHeaders,
  };
  if (exchange.statusMessage) fixture.statusMessage = exchange.statusMessage;

  if (exchange.responseBody) {
    const buffer = Buffer.from(exchange.responseBody, 'base64');
    const utf8 = buffer.toString('utf8');
    // Buffer.from(utf8, 'utf8') round-tripping back to the exact same bytes
    // means this was valid UTF-8 to begin with (not, say, a gzip-compressed
    // or otherwise binary body) — safe, and far more useful in a fixture a
    // human might commit/diff/edit, to store as plain text instead of a
    // base64 blob.
    if (Buffer.from(utf8, 'utf8').equals(buffer)) {
      fixture.responseBody = utf8;
    } else {
      fixture.responseBody = exchange.responseBody;
      fixture.responseBodyEncoding = 'base64';
    }
  }

  const filename = `${String(sequence).padStart(5, '0')}-${exchange.method.toLowerCase()}-${slugify(pathname)}.json`;
  return { fixture, filename };
}
