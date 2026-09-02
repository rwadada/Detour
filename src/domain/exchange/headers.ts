/** A Node-style headers object: values may be a string or a multi-value string array (e.g. `set-cookie`), or absent. */
export type RawHeaders = Record<string, string | string[] | undefined>;

/** Flattens a Node headers object (values may be a string or string[]) into the plain string map the breakpoint wire format uses. */
export function flattenHeaders(headers: RawHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * Case-insensitively looks up a header value by name. Node's own HTTP/1.1
 * parser always lowercases `IncomingMessage.headers` keys, so a direct
 * `headers[name]` lookup works for any exchange captured straight off the
 * wire — but a `rewrite` rule's `request.headers`/`response.headers` (from
 * rules.json) or a breakpoint edit's `headers` (typed by hand in the
 * dashboard) can carry any casing, so callers that need to find a specific
 * header regardless of source should use this instead of a bracket lookup.
 */
export function findHeader(headers: Readonly<RawHeaders>, name: string): string | string[] | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}
