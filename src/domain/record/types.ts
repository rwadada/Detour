/**
 * One replayable HTTP response, recorded by `detour record` and served back
 * by `detour serve` (issue #149) — deliberately host-less: `detour serve`
 * is a direct mock server, not a proxy, so a client points its base URL
 * straight at it and only `method`/`path` (not the original host) matter
 * for matching a request back to what was recorded.
 */
export interface Fixture {
  method: string;
  /** Path + query string, no scheme/host — e.g. `/orders/1?expand=items`. */
  path: string;
  status: number;
  statusMessage?: string;
  /** A `string[]` value is a genuine multi-value header (e.g. more than one `Set-Cookie`) — never comma-joined, which would corrupt it once `detour serve` re-emits it onto a real response. */
  responseHeaders: Record<string, string | string[]>;
  /** Absent when the recorded response had no body. */
  responseBody?: string;
  /**
   * `'base64'` when `responseBody` is base64-encoded — a body that isn't
   * valid UTF-8 (binary content, or a still-compressed one — detour never
   * decompresses a captured body, matching `CapturedExchange` elsewhere).
   * Omitted (not `false`) means `responseBody` is plain UTF-8 text, which
   * is the common case and keeps a JSON/text fixture human-readable and
   * diffable once committed to a repo.
   */
  responseBodyEncoding?: 'base64';
}
