import type { IncomingHttpHeaders } from 'node:http';
import type { CapturedExchange, CapturedWebSocketConnection, WebSocketFrameRecord } from '../exchange/types';

/**
 * How much detail `--dump` prints for each exchange (issue #15): `summary`
 * (default) is today's single line via `logExchange`; `full` additionally
 * prints the redacted request/response headers and body to the console
 * (`formatExchangeDump`, via `presentation/logger.ts`'s `logExchangeFull`);
 * `file` skips the console spam and instead writes that same redacted dump
 * to a file per exchange (`infra/fs/dumpFileWriter.ts`).
 */
export type DumpLevel = 'summary' | 'full' | 'file';

const DUMP_LEVELS: readonly DumpLevel[] = ['summary', 'full', 'file'];

/** Whether `value` is a recognized `DumpLevel` — used by the CLI to validate `--dump <level>`. */
export function isDumpLevel(value: string): value is DumpLevel {
  return (DUMP_LEVELS as readonly string[]).includes(value);
}

const REDACTED = '[REDACTED]';

/**
 * Header names (lowercase) whose values are replaced with `[REDACTED]` in
 * `full`/`file` dumps, since they routinely carry credentials that
 * shouldn't end up on a terminal or on disk in plaintext.
 */
export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

/**
 * Returns a copy of `headers` with every sensitive header's value replaced
 * by `[REDACTED]` (matched case-insensitively; the header name itself is
 * kept as-is). Multi-value headers (e.g. `set-cookie` as `string[]`) are
 * redacted as a whole rather than per-entry, since a single leaked cookie
 * in the array would defeat the point.
 */
export function redactHeaders(headers: Readonly<IncomingHttpHeaders>): IncomingHttpHeaders {
  const redacted: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? REDACTED : value;
  }
  return redacted;
}

function formatHeaders(headers: Readonly<IncomingHttpHeaders>): string {
  const entries = Object.entries(redactHeaders(headers));
  if (entries.length === 0) return '  (none)';
  return entries.map(([name, value]) => `  ${name}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\n');
}

/**
 * Decodes a captured base64 body for display: pretty-printed JSON when it
 * parses as such, the raw UTF-8 text otherwise. Binary bodies come out as
 * whatever (likely unreadable) text `Buffer#toString('utf8')` produces —
 * good enough for a debug dump, not a claim of correctness.
 */
function formatBody(body: string | undefined, truncated: boolean | undefined): string {
  if (body === undefined) return '  (empty)';
  const text = Buffer.from(body, 'base64').toString('utf8');
  const pretty = tryPrettyJson(text);
  const suffix = truncated ? '\n  … (truncated)' : '';
  return `${indent(pretty)}${suffix}`;
}

function tryPrettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function formatStatusLine(status: number, statusMessage: string | undefined, durationMs: number | undefined): string {
  const message = statusMessage ? ` ${statusMessage}` : '';
  const duration = durationMs !== undefined ? ` (${durationMs}ms)` : '';
  return `${status}${message}${duration}`;
}

const SEPARATOR = '='.repeat(60);

/**
 * Renders a full, human-readable dump of one exchange — request line,
 * headers (redacted), body, then (once available) the response's status,
 * headers, and body. Used by both the `full` (console) and `file` dump
 * levels, so the two stay identical apart from where the text ends up.
 */
export function formatExchangeDump(exchange: Readonly<CapturedExchange>): string {
  const lines: string[] = [
    SEPARATOR,
    `${exchange.method} ${exchange.url}`,
    'Request headers:',
    formatHeaders(exchange.requestHeaders),
    'Request body:',
    formatBody(exchange.requestBody, exchange.requestBodyTruncated),
  ];

  if (exchange.statusCode !== undefined) {
    lines.push(
      '-'.repeat(60),
      formatStatusLine(exchange.statusCode, exchange.statusMessage, exchange.durationMs),
      'Response headers:',
      formatHeaders(exchange.responseHeaders ?? {}),
      'Response body:',
      formatBody(exchange.responseBody, exchange.responseBodyTruncated),
    );
  }

  if (exchange.error) {
    lines.push(`Error: ${exchange.error}`);
  }

  lines.push(SEPARATOR);
  return lines.join('\n');
}

/** Renders one captured WebSocket frame as a single labeled, indented block — reusing `formatBody`'s JSON pretty-printing for `message` frames. */
function formatWebSocketFrame(frame: WebSocketFrameRecord): string {
  const arrow = frame.direction === 'toServer' ? '→ server' : '→ client';
  let kind: string = frame.type;
  if (frame.type === 'message') kind = frame.binary ? 'binary' : 'text';
  const header = `  [${new Date(frame.at).toISOString()}] ${arrow} ${kind} (${frame.size}B)`;
  if (frame.type !== 'message') return header;
  return `${header}\n${indent(formatBody(frame.data, frame.truncated))}`;
}

/**
 * Renders a full, human-readable dump of one WebSocket connection — the
 * upgrade request's (redacted) headers, every captured frame in order, then
 * (once known) how the connection closed. Mirrors `formatExchangeDump`'s
 * shape and is used the same way by both the `full` (console) and `file`
 * dump levels.
 */
export function formatWebSocketDump(connection: Readonly<CapturedWebSocketConnection>): string {
  const lines: string[] = [
    SEPARATOR,
    `WS ${connection.url}`,
    'Request headers:',
    formatHeaders(connection.requestHeaders),
  ];

  const frameCountLabel = connection.framesTruncated
    ? `${connection.frameCount} total, showing the last ${connection.frames.length}`
    : `${connection.frameCount}`;
  lines.push(`Frames (${frameCountLabel}):`);
  if (connection.frames.length === 0) {
    lines.push('  (none)');
  } else {
    for (const frame of connection.frames) lines.push(formatWebSocketFrame(frame));
  }

  if (connection.closedAt !== undefined) {
    let by = '';
    if (connection.closedByServer !== undefined)
      by = connection.closedByServer ? ' (closed by server)' : ' (closed by client)';
    const code = connection.closeCode !== undefined ? connection.closeCode : '(none)';
    const reason = connection.closeReason ? ` ${connection.closeReason}` : '';
    const duration = connection.durationMs !== undefined ? ` (${connection.durationMs}ms)` : '';
    lines.push('-'.repeat(60), `Closed: ${code}${reason}${by}${duration}`);
  }

  if (connection.error) {
    lines.push(`Error: ${connection.error}`);
  }

  lines.push(SEPARATOR);
  return lines.join('\n');
}
