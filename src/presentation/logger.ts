import { formatExchangeDump, formatWebSocketDump } from '../domain/dump/dumpPolicy';
import { findHeader } from '../domain/exchange/headers';
import type { CapturedExchange, CapturedWebSocketConnection, ProxyErrorEvent } from '../domain/exchange/types';
import { formatGrpcSection, type GrpcExchangeInfo } from '../domain/grpc/grpcDumpFormat';
import { isGrpcContentType, parseGrpcPath } from '../domain/grpc/grpcFraming';

const ansi = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

// Respect NO_COLOR / non-TTY output rather than spraying escape codes into files/pipes.
const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code: string, text: string): string {
  return colorEnabled ? `${code}${text}${ansi.reset}` : text;
}

function statusCode(status?: number): string {
  if (!status) return paint(ansi.dim, '---');
  if (status >= 500) return paint(ansi.red, String(status));
  if (status >= 400) return paint(ansi.yellow, String(status));
  if (status >= 300) return paint(ansi.cyan, String(status));
  return paint(ansi.green, String(status));
}

/**
 * Lightweight gRPC detection (issue #18) for the one-line summary: needs
 * only the request content-type and URL path, so — unlike the full decode
 * in `infra/grpc/grpcExchangeInfo.ts` — it's always on, with no `--proto`
 * required, and shown as e.g. `[gRPC helloworld.Greeter/SayHello]`.
 */
function grpcTag(exchange: Readonly<CapturedExchange>): string {
  if (!isGrpcContentType(findHeader(exchange.requestHeaders, 'content-type'))) return '';
  let pathname: string;
  try {
    pathname = new URL(exchange.url).pathname;
  } catch {
    return '';
  }
  const parsed = parseGrpcPath(pathname);
  return parsed ? paint(ansi.dim, `[gRPC ${parsed.service}/${parsed.method}]`) : '';
}

/** Logs a completed request/response exchange as a single readable line. */
export function logExchange(exchange: Readonly<CapturedExchange>): void {
  const method = paint(ansi.magenta, exchange.method.padEnd(6));
  const status = statusCode(exchange.statusCode);
  const duration = exchange.durationMs !== undefined ? paint(ansi.dim, `${exchange.durationMs}ms`) : '';
  const size = exchange.responseBodySize > 0 ? paint(ansi.dim, `${formatBytes(exchange.responseBodySize)}`) : '';
  const rule = exchange.ruleName ? paint(ansi.dim, `[rule: ${exchange.ruleName}]`) : '';
  const grpc = grpcTag(exchange);

  console.log(`${method} ${status} ${exchange.url} ${duration} ${size} ${grpc} ${rule}`.replace(/\s+/g, ' ').trim());
  if (exchange.error) {
    console.log(`  ${paint(ansi.red, '✖')} ${exchange.error}`);
  }
}

/** Prints the full request/response dump (`--dump full`) — headers redacted, body pretty-printed where JSON. */
export function logExchangeFull(exchange: Readonly<CapturedExchange>): void {
  console.log(formatExchangeDump(exchange));
}

/** Prints the decoded gRPC messages for an exchange (`--dump full`), appended after `logExchangeFull`'s regular headers/body dump. */
export function logGrpcSection(info: GrpcExchangeInfo): void {
  console.log(formatGrpcSection(info));
}

/** Logs a closed (or errored) WebSocket connection as a single readable line — mirrors `logExchange`, fired once the connection ends since (unlike a request/response) it has no other natural "done" point. */
export function logWebSocketConnection(connection: Readonly<CapturedWebSocketConnection>): void {
  const proto = paint(ansi.magenta, (connection.isSSL ? 'WSS' : 'WS').padEnd(6));
  const outcome = connection.error
    ? paint(ansi.red, 'error')
    : paint(ansi.green, `closed ${connection.closeCode ?? ''}`.trim());
  const duration = connection.durationMs !== undefined ? paint(ansi.dim, `${connection.durationMs}ms`) : '';
  const frames = paint(ansi.dim, `${connection.frameCount} frame${connection.frameCount === 1 ? '' : 's'}`);

  console.log(`${proto} ${outcome} ${connection.url} ${duration} ${frames}`.replace(/\s+/g, ' ').trim());
  if (connection.error) {
    console.log(`  ${paint(ansi.red, '✖')} ${connection.error}`);
  }
}

/** Prints the full WebSocket connection dump (`--dump full`) — headers redacted, every frame listed. */
export function logWebSocketFull(connection: Readonly<CapturedWebSocketConnection>): void {
  console.log(formatWebSocketDump(connection));
}

export function logProxyError(event: ProxyErrorEvent): void {
  console.error(`${paint(ansi.red, '✖ proxy error')} [${event.errorKind}] ${event.message}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
