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
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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
