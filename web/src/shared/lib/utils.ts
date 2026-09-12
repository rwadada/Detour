import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui's standard class-merging helper: clsx for conditional classes, tailwind-merge to resolve conflicting utility classes. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// Deliberately duplicated (not imported) from src/logger.ts's formatBytes —
// same idea, but this one spaces the unit for readability in the wider UI
// (the CLI's compact log line drops the space). Keep both in sync if the
// rounding/threshold logic ever changes.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false }) + `.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** Number of raw bytes a base64-captured body decodes to (i.e. how much was actually captured, pre-truncation-cap). */
export function capturedByteLength(base64: string): number {
  try {
    return atob(base64).length;
  } catch {
    return 0;
  }
}

/** Decodes a base64-captured body to text. Returns undefined for bodies that aren't valid UTF-8 (likely binary). */
export function decodeCapturedBody(base64: string): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(base64));
  } catch {
    return undefined;
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The `Content-Encoding` values `decodeCapturedBodyAsync` knows how to reverse. */
const DECOMPRESSIBLE_ENCODINGS = ['gzip', 'x-gzip', 'deflate', 'br'] as const;

/**
 * Case-insensitively reads a single-value header out of a captured
 * exchange's header map (which stores multi-value headers, e.g.
 * `set-cookie`, as an array) — a captured exchange's own headers come off
 * the wire already lowercased, but a `rewrite` rule or mock response can
 * spell a name with any casing.
 */
export function findHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Decompresses `bytes` per a single `Content-Encoding` coding using the
 * browser's native `DecompressionStream`. Unknown/unsupported formats (or a
 * runtime without brotli support) reject — callers fall back to treating
 * the body as uncompressed.
 */
async function decompress(bytes: Uint8Array, format: string): Promise<Uint8Array> {
  // `Uint8Array` overlaps `BufferSource`, but the DOM lib's `BlobPart` type
  // doesn't say so — a cast is needed, not a real type mismatch.
  const stream = new Blob([bytes as BufferSource]).stream().pipeThrough(new DecompressionStream(format as never));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decodes a base64-captured body to text, first reversing a `Content-Encoding`
 * the server applied — otherwise a gzipped/brotli JSON response (extremely
 * common for real APIs) is just opaque compressed bytes, which fail the
 * plain UTF-8 decode and get reported as "binary" even though the logical
 * body is perfectly readable text (issue #115). Returns undefined only when
 * the bytes — decompressed, if `contentEncoding` named a coding — still
 * aren't valid UTF-8.
 */
export async function decodeCapturedBodyAsync(base64: string, contentEncoding?: string): Promise<string | undefined> {
  const bytes = base64ToBytes(base64);
  const coding = contentEncoding?.trim().toLowerCase().split(',')[0]?.trim();

  if (coding && (DECOMPRESSIBLE_ENCODINGS as readonly string[]).includes(coding)) {
    try {
      const format = coding === 'x-gzip' ? 'gzip' : coding;
      const decompressed = await decompress(bytes, format);
      return new TextDecoder('utf-8', { fatal: true }).decode(decompressed);
    } catch {
      // Decompression failed — a truncated capture (the stream was cut off
      // mid-compression), a mislabeled encoding, or a format this runtime's
      // DecompressionStream doesn't support (e.g. older brotli support).
      // Fall through and try the raw bytes as plain UTF-8 instead of giving
      // up outright.
    }
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The inverse of `decodeCapturedBody`: UTF-8-encodes `text` and base64-encodes the result, for sending a breakpoint's edited body back to the server. */
export function encodeBodyToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Pretty-prints `text` as JSON if it parses, otherwise returns it unchanged. */
export function tryPrettyJson(text: string): { text: string; isJson: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), isJson: true };
  } catch {
    return { text, isJson: false };
  }
}

export function parseQueryParams(url: string): [string, string][] {
  try {
    return Array.from(new URL(url).searchParams.entries());
  } catch {
    return [];
  }
}

/** Renders a flat headers map as `Name: value` lines, for a breakpoint editor's editable textarea. */
export function headersToEditableText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

/** The inverse of `headersToEditableText`. Blank lines and lines without a `:` are ignored. */
export function parseEditableHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const name = line.slice(0, colonIndex).trim();
    if (!name) continue;
    headers[name] = line.slice(colonIndex + 1).trim();
  }
  return headers;
}

/** Flattens a headers record (values may be a string or string[]) into displayable rows. */
export function headerRows(headers: Record<string, string | string[] | undefined> | undefined): [string, string][] {
  if (!headers) return [];
  const rows: [string, string][] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    rows.push([key, Array.isArray(value) ? value.join(', ') : value]);
  }
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Renders `headerRows` output as `Name: value` lines, for copying a header section on its own (issue #67) — the same shape `headersToEditableText` produces, just from rows rather than a raw record. */
export function headerRowsToText(rows: [string, string][]): string {
  return rows.map(([name, value]) => `${name}: ${value}`).join('\n');
}
