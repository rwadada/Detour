import type { CapturedExchange, HeaderMap } from '@/shared/api';

/**
 * The search box's filter expression (issue #213): a small, mitmproxy-flavoured
 * language that sits on top of the original "URL contains" search.
 *
 *   status:4xx host:api.example.com -method:OPTIONS body:"error_code" duration:>1000
 *
 * - Terms are separated by whitespace and ANDed. A leading `-` negates one.
 * - `-word` negates a plain word too, but only alongside a recognised key
 *   (`status:200 -analytics`); on its own it stays the literal text it always
 *   was, so a search for `-api` still finds URLs containing `-api`.
 * - A value may be quoted (`body:"two words"`) to contain spaces.
 * - Only the keys below are recognised; anything else is plain text. A query
 *   with no recognised key is therefore one case-insensitive substring match
 *   against the URL, exactly as before this existed (so `http://x/a b` and
 *   `localhost:3000` keep working).
 * - A recognised key with an unusable value (`duration:abc`) is matched as
 *   literal URL text rather than silently dropped, and one with no value yet
 *   (`status:` while typing) is ignored so the list doesn't flicker empty.
 *
 * Keys: `url` `host` `method` `status` `type` `header` `reqheader` `resheader`
 * `body` `reqbody` `resbody` `duration` `size` `process` `rule` `proto`.
 * Numeric keys (`status`, `duration`, `size`) take `N`, `=N`, `>N`, `>=N`,
 * `<N`, `<=N`; `status` also takes a class (`4xx`) and `size` a `kb`/`mb`
 * suffix. `header:name` means "has this header", `header:name=text` "its
 * value contains text". Bodies are searched only as far as they were captured
 * (size-capped, and not at all while a body is still in flight).
 */

export type ExchangePredicate = (exchange: CapturedExchange) => boolean;

const KEYS = [
  'url',
  'host',
  'method',
  'status',
  'type',
  'header',
  'reqheader',
  'resheader',
  'body',
  'reqbody',
  'resbody',
  'duration',
  'size',
  'process',
  'rule',
  'proto',
] as const;
type Key = (typeof KEYS)[number];

const isKey = (s: string): s is Key => (KEYS as readonly string[]).includes(s);

interface RawTerm {
  negated: boolean;
  key: Key | null;
  value: string;
  /** The text as typed, used when the term has to fall back to plain URL text. */
  raw: string;
}

/** Splits on whitespace, keeping a `"quoted value"` (after `key:`) in one piece. */
function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of query) {
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
    } else if (/\s/.test(ch) && !quoted) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Strips surrounding quotes; a still-open `"abc` (mid-typing) loses its opening quote too, so it matches `abc` rather than nothing. */
const unquote = (v: string): string => {
  if (!v.startsWith('"')) return v;
  return v.length >= 2 && v.endsWith('"') ? v.slice(1, -1) : v.slice(1);
};

function toRawTerm(token: string): RawTerm {
  const negated = token.startsWith('-') && token.length > 1;
  const body = negated ? token.slice(1) : token;
  const colon = body.indexOf(':');
  if (colon > 0) {
    const key = body.slice(0, colon).toLowerCase();
    if (isKey(key)) return { negated, key, value: unquote(body.slice(colon + 1)), raw: token };
  }
  return { negated, key: null, value: unquote(body), raw: token };
}

type Compare = (actual: number) => boolean;

const SIZE_UNITS: Record<string, number> = { '': 1, b: 1, k: 1024, kb: 1024, m: 1024 * 1024, mb: 1024 * 1024 };

/** `1000`, `=1000`, `>1000`, `>=1k`, `<2mb`… — `null` when it isn't one. */
function parseComparison(value: string, units: boolean): Compare | null {
  const m = value.trim().match(/^(>=|<=|=|>|<)?\s*(\d+(?:\.\d+)?)\s*([a-z]*)$/i);
  if (!m) return null;
  const unit = (m[3] ?? '').toLowerCase();
  if (unit && !(units && unit in SIZE_UNITS)) return null;
  const n = Number(m[2]) * (SIZE_UNITS[unit] ?? 1);
  switch (m[1]) {
    case '>':
      return (a) => a > n;
    case '>=':
      return (a) => a >= n;
    case '<':
      return (a) => a < n;
    case '<=':
      return (a) => a <= n;
    default:
      return (a) => a === n;
  }
}

const includesCI = (haystack: string | undefined, needle: string): boolean =>
  haystack !== undefined && haystack.toLowerCase().includes(needle.toLowerCase());

function headerValue(headers: HeaderMap | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== undefined) return Array.isArray(value) ? value.join(', ') : value;
  }
  return undefined;
}

/** `name` alone → the header is present; `name=text` → its value contains `text`. */
function matchHeader(headers: HeaderMap | undefined, spec: string): boolean {
  const eq = spec.indexOf('=');
  if (eq === -1) return headerValue(headers, spec) !== undefined;
  const value = headerValue(headers, spec.slice(0, eq));
  return value !== undefined && includesCI(value, unquote(spec.slice(eq + 1)));
}

const decoder = new TextDecoder();
/** Decoded bodies, so a list re-filtered on every keystroke doesn't re-decode base64 each time. */
const decodedBodies = new WeakMap<CapturedExchange, { req?: string; res?: string }>();

function decodeBase64(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return decoder.decode(bytes);
  } catch {
    return '';
  }
}

function bodyText(exchange: CapturedExchange, side: 'req' | 'res'): string | undefined {
  const b64 = side === 'req' ? exchange.requestBody : exchange.responseBody;
  if (b64 === undefined) return undefined;
  const cache = decodedBodies.get(exchange) ?? {};
  decodedBodies.set(exchange, cache);
  cache[side] ??= decodeBase64(b64);
  return cache[side];
}

function statusMatcher(value: string): ExchangePredicate | null {
  if (value.toLowerCase() === 'pending') return (e) => e.statusCode === undefined && !e.passthrough;
  // `4x` / `4xx`: a class, also while it is still being typed.
  const cls = value.match(/^([1-5])(?:x|xx)?$/i);
  if (cls && /x/i.test(value)) {
    const digit = Number(cls[1]);
    return (e) => e.statusCode !== undefined && Math.floor(e.statusCode / 100) === digit;
  }
  // One or two digits can only be the start of a three-digit code (`4`, `40`
  // on the way to `404`) — match by prefix so typing never dips to nothing.
  if (/^\d{1,2}$/.test(value)) return (e) => e.statusCode !== undefined && String(e.statusCode).startsWith(value);
  const cmp = parseComparison(value, false);
  return cmp ? (e) => e.statusCode !== undefined && cmp(e.statusCode) : null;
}

/** Builds the predicate for one recognised key; `null` when `value` isn't usable for it. */
function build(key: Key, value: string): ExchangePredicate | null {
  switch (key) {
    case 'url':
      return (e) => includesCI(e.url, value);
    case 'host':
      return (e) => includesCI(e.host, value);
    case 'method':
      return (e) => e.method.toLowerCase() === value.toLowerCase();
    case 'status':
      return statusMatcher(value);
    case 'type':
      return (e) => includesCI(headerValue(e.responseHeaders, 'content-type'), value);
    case 'header':
      return (e) => matchHeader(e.requestHeaders, value) || matchHeader(e.responseHeaders, value);
    case 'reqheader':
      return (e) => matchHeader(e.requestHeaders, value);
    case 'resheader':
      return (e) => matchHeader(e.responseHeaders, value);
    case 'body':
      return (e) => includesCI(bodyText(e, 'req'), value) || includesCI(bodyText(e, 'res'), value);
    case 'reqbody':
      return (e) => includesCI(bodyText(e, 'req'), value);
    case 'resbody':
      return (e) => includesCI(bodyText(e, 'res'), value);
    case 'duration': {
      const cmp = parseComparison(value, false);
      return cmp ? (e) => e.durationMs !== undefined && cmp(e.durationMs) : null;
    }
    case 'size': {
      const cmp = parseComparison(value, true);
      return cmp ? (e) => cmp(e.responseBodySize) : null;
    }
    case 'process':
      return (e) => includesCI(e.clientProcess?.name, value);
    case 'rule':
      return (e) => includesCI(e.ruleName, value);
    case 'proto': {
      // `1`, `1.1`, `http1`, `http/1.1` all name HTTP/1.1; `2`, `http2`, `http/2` name HTTP/2.
      // A bare `http` leaves nothing to compare, so it falls back to URL text like any unusable value.
      const wanted = value.toLowerCase().replace(/^http\/?/, '');
      if (wanted === '') return null;
      return (e) => {
        const actual = e.protocol.toLowerCase().replace(/^http\//, '');
        return actual === wanted || actual.startsWith(`${wanted}.`);
      };
    }
  }
}

function compileTerm(term: RawTerm): ExchangePredicate | null {
  if (term.key === null)
    return term.negated ? (e) => !includesCI(e.url, term.value) : (e) => includesCI(e.url, term.value);
  if (term.value === '' || /^[<>=]+$/.test(term.value)) return null; // still typing `key:` / `key:>`
  const predicate = build(term.key, term.value) ?? ((e: CapturedExchange) => includesCI(e.url, term.raw));
  return term.negated ? (e) => !predicate(e) : predicate;
}

const MATCH_ALL: ExchangePredicate = () => true;

function compile(query: string): ExchangePredicate {
  const trimmed = query.trim();
  if (!trimmed) return MATCH_ALL;
  const terms = tokenize(trimmed).map(toRawTerm);
  // No recognised key anywhere: the whole query, spaces and all, is one URL
  // substring — what the search box did before expressions existed.
  if (terms.every((t) => t.key === null)) {
    const needle = terms.length === 1 && trimmed.startsWith('"') ? terms[0]!.value : trimmed;
    return (e) => includesCI(e.url, needle);
  }
  const predicates = terms.map(compileTerm).filter((p): p is ExchangePredicate => p !== null);
  return (e) => predicates.every((p) => p(e));
}

let lastQuery: string | undefined;
let lastPredicate: ExchangePredicate = MATCH_ALL;

/**
 * Compiles a search-box query into a predicate. The most recent query is
 * cached: the log table, counters and exports all re-filter the whole list
 * with the same query, and re-parsing it per exchange would be wasted work.
 */
export function compileFilterQuery(query: string): ExchangePredicate {
  if (query !== lastQuery) {
    lastPredicate = compile(query);
    lastQuery = query;
  }
  return lastPredicate;
}
