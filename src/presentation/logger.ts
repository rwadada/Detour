import { formatExchangeDump } from '../domain/dump/dumpPolicy';
import type { CapturedExchange, ProxyErrorEvent } from '../domain/exchange/types';

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

/** Logs a completed request/response exchange as a single readable line. */
export function logExchange(exchange: Readonly<CapturedExchange>): void {
  const method = paint(ansi.magenta, exchange.method.padEnd(6));
  const status = statusCode(exchange.statusCode);
  const duration = exchange.durationMs !== undefined ? paint(ansi.dim, `${exchange.durationMs}ms`) : '';
  const size = exchange.responseBodySize > 0 ? paint(ansi.dim, `${formatBytes(exchange.responseBodySize)}`) : '';
  const rule = exchange.ruleName ? paint(ansi.dim, `[rule: ${exchange.ruleName}]`) : '';

  console.log(`${method} ${status} ${exchange.url} ${duration} ${size} ${rule}`.replace(/\s+/g, ' ').trim());
  if (exchange.error) {
    console.log(`  ${paint(ansi.red, '✖')} ${exchange.error}`);
  }
}

/** Prints the full request/response dump (`--dump full`) — headers redacted, body pretty-printed where JSON. */
export function logExchangeFull(exchange: Readonly<CapturedExchange>): void {
  console.log(formatExchangeDump(exchange));
}

export function logProxyError(event: ProxyErrorEvent): void {
  console.error(`${paint(ansi.red, '✖ proxy error')} [${event.errorKind}] ${event.message}`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
