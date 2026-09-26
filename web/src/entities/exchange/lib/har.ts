import type { CapturedExchange, ExchangeTiming, HeaderMap, UpstreamCertificate } from '@/shared/api';

/**
 * HAR 1.2 export/import (issue #19). HAR is a lossy format relative to
 * `CapturedExchange` — it has no fields for `id`, `ruleName`, `error`,
 * `protocol`, or truncation flags, and its body fields are plain text with
 * no first-class "this is base64" marker. Rather than choose between "HAR
 * that other tools can read" and "round-trips losslessly through our own
 * importer", every entry carries both: standard HAR fields for interop with
 * Chrome/Firefox/other HAR consumers, plus a `_detour` extension (the `_`
 * prefix is HAR's documented convention for custom fields, see
 * http://www.softwareishard.com/blog/har-12-spec/#extension) that round-trips
 * a re-imported Detour HAR back to the exact original `CapturedExchange`.
 */

export interface HarNameValue {
  name: string;
  value: string;
}

export interface HarPostData {
  mimeType: string;
  text: string;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
  /** Present only when `text` is base64 (binary/undecodable body) — matches the official HAR 1.2 field. */
  encoding?: 'base64';
}

/** Fields `CapturedExchange` has that HAR's schema has no slot for; recovered on import when present. */
export interface DetourHarExtension {
  id: string;
  host: string;
  isSSL: boolean;
  protocol: CapturedExchange['protocol'];
  requestBodyBase64?: string;
  requestBodyTruncated?: boolean;
  responseBodyBase64?: string;
  responseBodyTruncated?: boolean;
  statusMessage?: string;
  ruleName?: string;
  error?: string;
  /** The upstream server's real TLS certificate (issue #160) — no standard HAR field for it. */
  certificate?: UpstreamCertificate;
  /** Which protocol the proxy→upstream leg actually spoke (issue #166) — independent of `protocol` above (the client-facing side); no standard HAR field distinguishes the two. */
  upstreamProtocol?: CapturedExchange['upstreamProtocol'];
  /**
   * The exact DNS/TCP/TLS/TTFB/transfer breakdown (issue #140), including
   * `connectionReused` — no standard HAR field for the last one, and the
   * standard `timings` object below is lossy for the rest (its `connect`
   * folds TCP+TLS together per the HAR 1.2 spec, and it has no field at
   * all for "no connection was made because this rode a reused socket").
   * Re-importing a Detour-authored HAR reads this instead of deriving from
   * `timings`, for an exact round-trip.
   */
  timing?: ExchangeTiming;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: HarNameValue[];
    headers: HarNameValue[];
    queryString: HarNameValue[];
    postData?: HarPostData;
    headersSize: -1;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: HarNameValue[];
    headers: HarNameValue[];
    content: HarContent;
    redirectURL: string;
    headersSize: -1;
    bodySize: number;
  };
  cache: Record<string, never>;
  /**
   * HAR 1.2's standard timing breakdown. `dns`/`connect`/`ssl` are omitted
   * by us on export in favor of the `_detour.timing` extension above (see
   * its own doc comment on why they'd be lossy); a foreign HAR (e.g. from
   * Chrome DevTools) does set them, and `-1` means "not measured" per the
   * spec, same as absent.
   */
  timings: { dns?: number; connect?: number; ssl?: number; send: number; wait: number; receive: number };
  _detour?: DetourHarExtension;
}

export interface HarLog {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** True for bytes that mean "this was binary, not text" once decoded — the Unicode replacement char, or a raw control byte other than tab/LF/CR. */
function looksBinary(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (text[i] === '�') return true;
    if (code <= 0x08 || (code >= 0x0e && code <= 0x1f)) return true;
  }
  return false;
}

/** Best-effort decode: returns the UTF-8 text if the base64 payload is valid UTF-8, else undefined. */
function tryDecodeBase64Text(base64: string): string | undefined {
  try {
    const text = base64ToUtf8(base64);
    return looksBinary(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

function headersToHarList(headers: HeaderMap | undefined): HarNameValue[] {
  if (!headers) return [];
  const list: HarNameValue[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) list.push({ name, value: v });
    } else {
      list.push({ name, value });
    }
  }
  return list;
}

function harListToHeaders(list: HarNameValue[] | undefined): HeaderMap {
  const headers: HeaderMap = {};
  for (const { name, value } of list ?? []) {
    const key = name.toLowerCase();
    const existing = headers[key];
    if (existing === undefined) {
      headers[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      headers[key] = [existing, value];
    }
  }
  return headers;
}

function queryStringOf(url: string): HarNameValue[] {
  try {
    return Array.from(new URL(url).searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function contentTypeOf(headers: HeaderMap | undefined): string {
  const value = headers?.['content-type'];
  return (Array.isArray(value) ? value[0] : value) ?? 'application/octet-stream';
}

/** The HAR `response.content` text/encoding pair: decoded text when possible, else the raw base64 marked `encoding: 'base64'`. Omitted entirely when there's no body. */
function harResponseContentText(
  responseBody: string | undefined,
  responseText: string | undefined,
): Pick<HarContent, 'text' | 'encoding'> {
  if (!responseBody) return {};
  if (responseText !== undefined) return { text: responseText };
  return { text: responseBody, encoding: 'base64' };
}

/**
 * Builds the standard HAR `timings` object from Detour's own DNS/TCP/TLS/
 * TTFB/transfer breakdown (issue #140/#167) — `dns`/`ssl` map directly,
 * `connect` folds TCP+TLS together (HAR 1.2: "If [ssl] is defined then the
 * time is also included in the connect field"), and `wait` takes `ttfbMs`
 * (which, like HAR's `wait`, covers request upload too — see
 * `ExchangeTiming.ttfbMs`'s own doc comment) with `receive` from
 * `transferMs`. `-1` is HAR's own "not measured" sentinel. Falls back to
 * the pre-#167 behavior (everything folded into `wait`) when there's no
 * `timing` at all — an exchange that never reached upstream, or one
 * without a granular breakdown to begin with.
 */
function harTimingsOf(timing: ExchangeTiming | undefined, durationMs: number | undefined): HarEntry['timings'] {
  if (!timing) return { dns: -1, connect: -1, ssl: -1, send: 0, wait: durationMs ?? 0, receive: 0 };
  const hasConnect = timing.tcpMs !== undefined || timing.tlsMs !== undefined;
  return {
    dns: timing.dnsMs ?? -1,
    connect: hasConnect ? (timing.tcpMs ?? 0) + (timing.tlsMs ?? 0) : -1,
    ssl: timing.tlsMs ?? -1,
    send: 0,
    wait: timing.ttfbMs ?? durationMs ?? 0,
    receive: timing.transferMs ?? 0,
  };
}

function exchangeToHarEntry(exchange: CapturedExchange): HarEntry {
  const requestText = exchange.requestBody ? tryDecodeBase64Text(exchange.requestBody) : undefined;
  const responseText = exchange.responseBody ? tryDecodeBase64Text(exchange.responseBody) : undefined;

  return {
    startedDateTime: new Date(exchange.startedAt).toISOString(),
    time: exchange.durationMs ?? 0,
    request: {
      method: exchange.method,
      url: exchange.url,
      httpVersion: exchange.protocol,
      cookies: [],
      headers: headersToHarList(exchange.requestHeaders),
      queryString: queryStringOf(exchange.url),
      postData: exchange.requestBody
        ? { mimeType: contentTypeOf(exchange.requestHeaders), text: requestText ?? exchange.requestBody }
        : undefined,
      headersSize: -1,
      bodySize: exchange.requestBodySize,
    },
    response: {
      status: exchange.statusCode ?? 0,
      statusText: exchange.statusMessage ?? '',
      httpVersion: exchange.protocol,
      cookies: [],
      headers: headersToHarList(exchange.responseHeaders),
      content: {
        size: exchange.responseBodySize,
        mimeType: contentTypeOf(exchange.responseHeaders),
        ...harResponseContentText(exchange.responseBody, responseText),
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: exchange.responseBodySize,
    },
    cache: {},
    timings: harTimingsOf(exchange.timing, exchange.durationMs),
    _detour: {
      id: exchange.id,
      host: exchange.host,
      isSSL: exchange.isSSL,
      protocol: exchange.protocol,
      requestBodyBase64: exchange.requestBody,
      requestBodyTruncated: exchange.requestBodyTruncated,
      responseBodyBase64: exchange.responseBody,
      responseBodyTruncated: exchange.responseBodyTruncated,
      statusMessage: exchange.statusMessage,
      ruleName: exchange.ruleName,
      error: exchange.error,
      certificate: exchange.certificate,
      upstreamProtocol: exchange.upstreamProtocol,
      timing: exchange.timing,
    },
  };
}

export function exchangesToHar(exchanges: CapturedExchange[]): HarLog {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Detour Dashboard', version: '1' },
      entries: exchanges.map(exchangeToHarEntry),
    },
  };
}

let importCounter = 0;

/** Re-encodes a foreign HAR entry's `response.content` back to base64, respecting its `encoding` field when the source already gave us base64. */
function decodeHarResponseBody(content: HarContent): string | undefined {
  if (!content.text) return undefined;
  if (content.encoding === 'base64') return content.text;
  return utf8ToBase64(content.text);
}

function nextImportedId(fallbackIndex: number): string {
  importCounter += 1;
  return `imported-${fallbackIndex}-${importCounter}`;
}

/**
 * The inverse of `harTimingsOf`, for a foreign HAR with no `_detour.timing`
 * to read exactly instead (see `harEntryToExchange`). `-1` means "not
 * measured" per the HAR 1.2 spec; `connect` folds TCP+TLS together there,
 * so `tcpMs` is recovered by subtracting `ssl` back out when both are
 * present. `send`+`wait` are summed into `ttfbMs`, which covers request
 * upload too (see `ExchangeTiming.ttfbMs`'s own doc comment) — so does the
 * HAR pair together. `connectionReused` has no standard HAR field and is
 * never derived here. Returns `undefined` when every field is absent/`-1`
 * (no timing data at all — most real-world HAR exports only fill in a
 * subset, if any) rather than an all-fields-undefined `{}` that would
 * render identically in the Waterfall but isn't quite the same claim.
 *
 * `timings` is only *typed* as having every field required — nothing here
 * runtime-validates a parsed JSON file against that shape, so a foreign
 * HAR omitting one is read the same as it being `-1`.
 */
/**
 * `typeof value === 'number'`, not `value !== undefined` — a malformed
 * HAR's numeric field can just as easily be `null` (JSON has no
 * `undefined`), and `null >= 0` evaluates to `true` in JavaScript
 * (relational comparisons coerce `null` to `0`), so a naive `value !==
 * undefined && value >= 0` check would let a `null` field through
 * disguised as a real, non-negative measurement (agy code review).
 * Returns `undefined` for anything that isn't actually a non-negative
 * number, `-1` (HAR's own "not measured" sentinel) included.
 */
function nonNegativeNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 ? value : undefined;
}

function deriveTimingFromHar(timings: HarEntry['timings'] | undefined): ExchangeTiming | undefined {
  const t = timings as Partial<HarEntry['timings']> | undefined;
  if (!t) return undefined;

  const dnsMs = nonNegativeNumberOrUndefined(t.dns);
  const sslMs = nonNegativeNumberOrUndefined(t.ssl);
  const connectMs = nonNegativeNumberOrUndefined(t.connect);
  const tcpMs = connectMs !== undefined ? Math.max(connectMs - (sslMs ?? 0), 0) : undefined;
  const sendMs = nonNegativeNumberOrUndefined(t.send);
  const waitMs = nonNegativeNumberOrUndefined(t.wait);
  const ttfbMs = sendMs !== undefined || waitMs !== undefined ? (sendMs ?? 0) + (waitMs ?? 0) : undefined;
  const transferMs = nonNegativeNumberOrUndefined(t.receive);

  if (
    dnsMs === undefined &&
    tcpMs === undefined &&
    sslMs === undefined &&
    ttfbMs === undefined &&
    transferMs === undefined
  ) {
    return undefined;
  }
  return { dnsMs, tcpMs, tlsMs: sslMs, ttfbMs, transferMs };
}

function harEntryToExchange(entry: HarEntry, fallbackIndex: number): CapturedExchange {
  const ext = entry._detour;
  const startedAt = Date.parse(entry.startedDateTime) || Date.now();
  const durationMs = nonNegativeNumberOrUndefined(entry.time);

  const requestBody =
    ext?.requestBodyBase64 ?? (entry.request.postData ? utf8ToBase64(entry.request.postData.text) : undefined);
  const responseBody = ext?.responseBodyBase64 ?? decodeHarResponseBody(entry.response.content);

  return {
    id: ext?.id ?? nextImportedId(fallbackIndex),
    method: entry.request.method,
    url: entry.request.url,
    host: ext?.host ?? safeHostOf(entry.request.url),
    isSSL: ext?.isSSL ?? entry.request.url.startsWith('https:'),
    protocol: ext?.protocol ?? (entry.request.httpVersion === 'HTTP/2' ? 'HTTP/2' : 'HTTP/1.1'),
    requestHeaders: harListToHeaders(entry.request.headers),
    requestBodySize: nonNegativeNumberOrUndefined(entry.request.bodySize) ?? requestBody?.length ?? 0,
    requestBody,
    requestBodyTruncated: ext?.requestBodyTruncated,
    startedAt,
    statusCode: entry.response.status || undefined,
    statusMessage: ext?.statusMessage ?? entry.response.statusText,
    responseHeaders: harListToHeaders(entry.response.headers),
    responseBodySize: nonNegativeNumberOrUndefined(entry.response.bodySize) ?? responseBody?.length ?? 0,
    responseBody,
    responseBodyTruncated: ext?.responseBodyTruncated,
    finishedAt: durationMs !== undefined ? startedAt + durationMs : undefined,
    durationMs,
    // Not `ext?.timing ?? deriveTimingFromHar(...)`: a Detour-authored HAR
    // (`ext` present) whose exchange genuinely had no `timing` at all
    // would otherwise have one fabricated here from the approximated
    // standard `timings` fields `harTimingsOf` still writes for other
    // tools' benefit — `ext.timing` being undefined in that case means
    // exactly that, not "fall back to deriving it". Only derive at all for
    // a genuinely foreign HAR, which has no `_detour` extension to trust instead.
    timing: ext ? ext.timing : deriveTimingFromHar(entry.timings),
    error: ext?.error,
    ruleName: ext?.ruleName,
    certificate: ext?.certificate,
    upstreamProtocol: ext?.upstreamProtocol,
  };
}

function safeHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function harToExchanges(har: HarLog): CapturedExchange[] {
  return har.log.entries.map((entry, index) => harEntryToExchange(entry, index));
}

/** True when `value` looks like a HAR 1.2 document (has a `log.entries` array). */
function isHarLike(value: unknown): value is HarLog {
  if (typeof value !== 'object' || value === null) return false;
  const log = (value as { log?: unknown }).log;
  return typeof log === 'object' && log !== null && Array.isArray((log as { entries?: unknown }).entries);
}

/** True when `value` looks like our own native JSON export (a plain array of captured exchanges). */
function isExchangeArray(value: unknown): value is CapturedExchange[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === 'object' && item !== null && 'id' in item && 'method' in item && 'url' in item,
    )
  );
}

/**
 * Parses a saved log file's text content — either a HAR 1.2 document or a
 * native Detour JSON export — into `CapturedExchange[]` for the LogViewer.
 * Throws a descriptive `Error` (shown to the user) on anything else.
 */
export function parseImportedLog(text: string): CapturedExchange[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Couldn't parse this file as JSON. Choose a HAR 1.2 file or a Detour JSON export.");
  }
  if (isHarLike(parsed)) return harToExchanges(parsed);
  if (isExchangeArray(parsed)) return parsed;
  throw new Error('Unrecognized file format. Choose a HAR 1.2 file or a Detour JSON export.');
}
