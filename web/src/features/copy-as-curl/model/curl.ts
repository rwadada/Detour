import type { CapturedExchange } from '@/shared/api';
import { decodeCapturedBody } from '@/shared/lib/utils';

/** Wraps `value` in single quotes for a POSIX shell, escaping any embedded single quote (`'` → `'\''`). */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Builds a `curl` command that reproduces a captured request (issue #19's
 * Copy as curl) — method, URL, every request header, and the body if one
 * was captured and decodes as text. A binary/undecodable body is called out
 * with a placeholder rather than silently dropped or corrupted, since curl
 * has no way to represent it as a shell-safe `--data-raw` argument here.
 */
export function buildCurlCommand(exchange: CapturedExchange): string {
  const parts = ['curl', '-X', exchange.method, shellEscape(exchange.url)];

  for (const [name, value] of Object.entries(exchange.requestHeaders)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      parts.push('-H', shellEscape(`${name}: ${v}`));
    }
  }

  if (exchange.requestBody) {
    const text = decodeCapturedBody(exchange.requestBody);
    parts.push('--data-raw', shellEscape(text ?? '<binary body omitted>'));
  }

  return parts.join(' ');
}
