/**
 * How `BodyViewer` renders a captured body based on its `Content-Type`
 * (issue #142) — beyond this, an unrecognized/absent type falls back to
 * today's behavior (`'text'`: try pretty-printing as JSON, else raw text).
 */
export type BodyFormat =
  | 'image'
  | 'html'
  | 'css'
  | 'javascript'
  | 'json'
  | 'xml'
  | 'form-urlencoded'
  | 'multipart'
  | 'text';

/** Classifies a `Content-Type` header value (parameters like `; charset=utf-8` ignored) into a `BodyFormat`. */
export function detectBodyFormat(contentType: string | undefined): BodyFormat {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'text/css') return 'css';
  if (type === 'application/javascript' || type === 'text/javascript' || type === 'application/x-javascript') {
    return 'javascript';
  }
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml')) return 'xml';
  if (type === 'application/x-www-form-urlencoded') return 'form-urlencoded';
  if (type === 'multipart/form-data') return 'multipart';
  return 'text';
}

/** Reads `multipart/form-data`'s `boundary` parameter off a `Content-Type` header value, unquoting it if quoted. Undefined when absent/malformed. */
export function extractMultipartBoundary(contentType: string | undefined): string | undefined {
  const match = contentType?.match(/boundary=(?:"([^"]*)"|([^;]+))/i);
  if (!match) return undefined;
  return (match[1] ?? match[2])?.trim();
}

/** A single `multipart/form-data` part — a plain field's `value` is its decoded text; a file part's `value` is always `''` (its bytes are never meaningfully displayable inline), with `filename`/`contentType` describing what was uploaded instead. */
export interface MultipartField {
  name: string;
  value: string;
  filename?: string;
  contentType?: string;
}

/**
 * Splits a `multipart/form-data` body (already decoded as text — see
 * `BodyViewer`'s use of `iso-8859-1` for this so binary file parts survive
 * the round trip without corrupting the ASCII boundary markers surrounding
 * them) into its individual fields. Malformed parts (no blank-line
 * header/body separator) are skipped rather than thrown on — this is a
 * best-effort debug view, not a strict parser.
 */
export function parseMultipartFormData(text: string, boundary: string): MultipartField[] {
  const delimiter = `--${boundary}`;
  const fields: MultipartField[] = [];
  for (const rawPart of text.split(delimiter)) {
    const part = rawPart.replace(/^\r\n/, '').replace(/\r\n$/, '');
    if (!part || part === '--' || part.startsWith('--')) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 4);

    const disposition = headerText.match(/content-disposition:\s*form-data;(.*)/i)?.[1] ?? '';
    const name = disposition.match(/name="([^"]*)"/i)?.[1];
    if (name === undefined) continue;
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
    const contentType = headerText.match(/content-type:\s*([^\r\n]*)/i)?.[1]?.trim();

    fields.push({ name, value: filename !== undefined ? '' : body, filename, contentType });
  }
  return fields;
}

/** Parses `application/x-www-form-urlencoded` into ordered key/value pairs, preserving duplicate keys (each occurrence its own row) rather than collapsing them. */
export function parseFormUrlEncoded(text: string): [string, string][] {
  return Array.from(new URLSearchParams(text).entries());
}

/**
 * Whether `line` is a leaf element whose entire opening+text+closing sits on
 * one line (e.g. `<child>text</child>`, the result of there being no `><`
 * boundary — and so no break — around its inline text). Checked with plain
 * string operations, not a single `<tag>.*</tag>` regex: a capturing group
 * followed by an unbounded `.*` and a backreference is exactly the shape
 * that risks catastrophic backtracking on adversarial input, and a captured
 * response body is attacker-influenced input.
 */
function isLeafOnOneLine(line: string): boolean {
  if (!line.startsWith('<')) return false;
  const tagEnd = line.indexOf('>');
  if (tagEnd === -1) return false;
  let nameEnd = 1;
  while (nameEnd < line.length && /[\w:-]/.test(line[nameEnd]!)) nameEnd++;
  const tagName = line.slice(1, nameEnd);
  if (!tagName) return false;
  return line.length > tagEnd + 1 && line.endsWith(`</${tagName}>`);
}

/**
 * Pretty-prints XML by inserting a newline (and indentation matching
 * nesting depth) between adjacent tags — a small best-effort formatter
 * (issue #142), not a real XML parser: good enough for the common case of
 * minified/single-line XML, imperfect for attribute values that themselves
 * contain `>`/`<`, which no debug body viewer needs to handle correctly.
 */
export function formatXml(xml: string): string {
  const withBreaks = xml.trim().replace(/>\s*</g, '>\n<');
  let depth = 0;
  const lines: string[] = [];
  for (const line of withBreaks.split('\n')) {
    const isClosingOnly = /^<\/[^>]+>$/.test(line);
    const isSelfClosing = /^<[^>]*\/>$/.test(line) || /^<\?[^>]*\?>$/.test(line) || /^<!--[\s\S]*-->$/.test(line);
    const isOpeningOnly = !isSelfClosing && !isLeafOnOneLine(line) && /^<[\w:!?][^>]*>$/.test(line);

    if (isClosingOnly) depth = Math.max(0, depth - 1);
    lines.push('  '.repeat(depth) + line);
    if (isOpeningOnly) depth += 1;
  }
  return lines.join('\n');
}
