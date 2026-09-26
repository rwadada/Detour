import type { IncomingHttpHeaders } from 'node:http';
import type { CapturedExchange } from './types';

/**
 * Parses a HAR 1.2 log into `CapturedExchange`s for `detour record
 * --from-har` (issue #167) — converting a HAR someone else's tool
 * recorded into `detour serve` fixtures via `buildFixtureFromExchange`,
 * the same function a live `detour record` run already uses.
 *
 * Deliberately narrower than the web dashboard's own HAR import
 * (`web/src/entities/exchange/lib/har.ts`): this only needs to produce
 * what `buildFixtureFromExchange` actually reads (`method`/`url`/
 * `statusCode`/`statusMessage`/`responseHeaders`/`responseBody`), plus
 * whatever's needed to satisfy `CapturedExchange`'s other required
 * fields with a sensible value — no `timing`/`certificate`/
 * `upstreamProtocol` mapping, since `Fixture` (`domain/record/types.ts`)
 * has no slot for any of those and a fixture is all this command
 * produces. If a Detour-authored HAR's `_detour` extension is present,
 * its exact `requestBodyBase64`/`responseBodyBase64`/`statusMessage` win
 * over the standard fields' lossier text-only equivalents, same
 * precedence as the dashboard's own importer.
 */

interface HarNameValue {
  name: string;
  value: string;
}

interface HarPostData {
  text?: string;
}

interface HarContent {
  text?: string;
  encoding?: string;
}

interface HarDetourExtension {
  id?: string;
  host?: string;
  isSSL?: boolean;
  protocol?: CapturedExchange['protocol'];
  requestBodyBase64?: string;
  responseBodyBase64?: string;
  statusMessage?: string;
}

interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request: {
    method: string;
    url: string;
    httpVersion?: string;
    headers?: HarNameValue[];
    postData?: HarPostData;
    bodySize?: number;
  };
  response: {
    status: number;
    statusText?: string;
    headers?: HarNameValue[];
    content?: HarContent;
    bodySize?: number;
  };
  _detour?: HarDetourExtension;
}

interface HarLog {
  log?: {
    entries?: HarEntry[];
  };
}

function isHarLog(value: unknown): value is HarLog {
  if (typeof value !== 'object' || value === null) return false;
  const log = (value as { log?: unknown }).log;
  return typeof log === 'object' && log !== null && Array.isArray((log as { entries?: unknown }).entries);
}

/**
 * Skips (rather than throws on) a malformed entry in `list` — a non-array
 * `list` itself, or an element missing a string `name`/`value` — instead
 * of letting one bad header line fail an otherwise-parseable HAR entry
 * outright (agy code review flagged the un-guarded version crashing with
 * a bare `TypeError` on either).
 */
function headersToMap(list: unknown): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  if (!Array.isArray(list)) return headers;
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const { name, value } = item as Partial<HarNameValue>;
    if (typeof name !== 'string' || typeof value !== 'string') continue;
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

function safeHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Re-encodes a foreign entry's `response.content` back to base64, respecting its `encoding` field when the source already gave us base64 — same logic as the dashboard's own `decodeHarResponseBody`. `content.text` isn't necessarily a string on a malformed HAR (agy code review) — treated the same as absent rather than crashing `Buffer.from` with an unhelpful type error. */
function decodeResponseBody(content: HarContent | undefined): string | undefined {
  if (typeof content?.text !== 'string' || content.text === '') return undefined;
  if (content.encoding === 'base64') return content.text;
  return Buffer.from(content.text, 'utf8').toString('base64');
}

/** HAR's `postData` has no `encoding` field (unlike `response.content`) — a request body is always assumed to be the UTF-8 text as-is, same assumption the dashboard's importer makes for a foreign HAR. Same non-string guard as `decodeResponseBody`. */
function decodeRequestBody(postData: HarPostData | undefined): string | undefined {
  if (typeof postData?.text !== 'string' || postData.text === '') return undefined;
  return Buffer.from(postData.text, 'utf8').toString('base64');
}

let importCounter = 0;

function nextImportedId(index: number): string {
  importCounter += 1;
  return `har-import-${index}-${importCounter}`;
}

function bodyByteLength(base64: string | undefined): number {
  return base64 ? Buffer.from(base64, 'base64').length : 0;
}

/**
 * `typeof value === 'number'`, not `value !== undefined` — a malformed
 * HAR's field can just as easily be `null` (JSON has no `undefined`), and
 * `null >= 0` evaluates to `true` in JavaScript (relational comparisons
 * coerce `null` to `0`), so a naive `value !== undefined && value >= 0`
 * check would let a `null` field through disguised as a real, non-negative
 * measurement (agy code review). Returns `undefined` for anything that
 * isn't actually a non-negative number, `-1` (HAR's own "not measured"
 * sentinel) included.
 */
function nonNegativeNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 ? value : undefined;
}

/** Throws a descriptive `Error` (not a bare `TypeError`) when `entry` is missing the fields every HAR 1.2 entry must have — a hand-edited or truncated HAR file, most likely. */
function validateEntry(entry: unknown, index: number): entry is HarEntry {
  const label = `HAR entry #${index}`;
  if (typeof entry !== 'object' || entry === null) throw new Error(`${label} is not an object`);
  const { request, response } = entry as Partial<HarEntry>;
  if (typeof request !== 'object' || request === null) throw new Error(`${label} is missing "request"`);
  if (typeof request.method !== 'string' || request.method === '') {
    throw new Error(`${label}: request.method must be a non-empty string`);
  }
  if (typeof request.url !== 'string' || request.url === '') {
    throw new Error(`${label}: request.url must be a non-empty string`);
  }
  if (typeof response !== 'object' || response === null) throw new Error(`${label} is missing "response"`);
  if (typeof response.status !== 'number') throw new Error(`${label}: response.status must be a number`);
  return true;
}

function harEntryToExchange(entry: HarEntry, index: number): CapturedExchange {
  const ext = entry._detour;
  const startedAt = entry.startedDateTime ? Date.parse(entry.startedDateTime) : NaN;
  const resolvedStartedAt = Number.isNaN(startedAt) ? Date.now() : startedAt;
  const durationMs = nonNegativeNumberOrUndefined(entry.time);

  const requestBody = ext?.requestBodyBase64 ?? decodeRequestBody(entry.request.postData);
  const responseBody = ext?.responseBodyBase64 ?? decodeResponseBody(entry.response.content);

  return {
    id: ext?.id ?? nextImportedId(index),
    method: entry.request.method,
    url: entry.request.url,
    host: ext?.host ?? safeHostOf(entry.request.url),
    isSSL: ext?.isSSL ?? entry.request.url.startsWith('https:'),
    protocol: ext?.protocol ?? (entry.request.httpVersion === 'HTTP/2' ? 'HTTP/2' : 'HTTP/1.1'),
    requestHeaders: headersToMap(entry.request.headers),
    requestBodySize: nonNegativeNumberOrUndefined(entry.request.bodySize) ?? bodyByteLength(requestBody),
    requestBody,
    startedAt: resolvedStartedAt,
    statusCode: entry.response.status || undefined,
    statusMessage: ext?.statusMessage ?? entry.response.statusText,
    responseHeaders: headersToMap(entry.response.headers),
    responseBodySize: nonNegativeNumberOrUndefined(entry.response.bodySize) ?? bodyByteLength(responseBody),
    responseBody,
    finishedAt: durationMs !== undefined ? resolvedStartedAt + durationMs : undefined,
    durationMs,
  };
}

/**
 * Parses a HAR 1.2 document's text into `CapturedExchange`s, in entry
 * order. Throws a descriptive `Error` — never a bare parse/type exception
 * — on invalid JSON, a document that isn't HAR-shaped, or an individual
 * entry missing a field every HAR 1.2 entry must have.
 */
export function parseHarLog(text: string): CapturedExchange[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't parse as JSON: ${reason}`, { cause: err });
  }
  if (!isHarLog(parsed)) {
    throw new Error('Not a HAR 1.2 document — expected a top-level "log.entries" array');
  }
  const entries = parsed.log?.entries ?? [];
  return entries.map((entry, index) => {
    // A final safety net, not the primary mechanism (`validateEntry` above
    // and the individual field guards throughout this file are): a HAR
    // field this file didn't anticipate being malformed in some other way
    // should still fail as a labeled, readable error rather than an
    // uncaught exception crashing the whole `detour record --from-har`
    // run over one bad entry (agy code review).
    try {
      validateEntry(entry, index);
      return harEntryToExchange(entry, index);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(`HAR entry #${index}`)) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`HAR entry #${index}: ${reason}`, { cause: err });
    }
  });
}
