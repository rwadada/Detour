/**
 * Example `script` rule module (issue #9), referenced by
 * `example.rule.json`'s `script-transform-orders` rule (disabled — copy
 * this file and adapt it, then flip that rule's `enabled` to `true`).
 *
 * A `script` rule points at a plain CommonJS module like this one via its
 * action's `path` (resolved relative to rules.json). Export either or both
 * of `beforeRequest`/`beforeResponse` — the ones you omit leave that phase
 * untouched. Both may be `async` (e.g. to call another service before
 * deciding what to change) and may return `undefined`/`null`/nothing at all
 * to leave everything as-is. Editing this file takes effect immediately,
 * the same as editing rules.json itself — no restart needed.
 */
module.exports = {
  /**
   * `req`: { method, url, headers, body } — `body` is the full,
   * untruncated request `Buffer` (never cut off at the dashboard's 256 KiB
   * capture cap). Return a partial `{ method?, headers?, body? }`; any
   * field you omit keeps its original value. `body` may be a `Buffer` or a
   * `string`.
   */
  beforeRequest(req) {
    return {
      headers: { ...req.headers, 'x-detour-script': 'before-request' },
    };
  },

  /**
   * `req`: same shape as above. `res`: { status, statusMessage, headers,
   * body } for the upstream response — `body` is likewise the full
   * response, and `headers` values may be a `string` or `string[]` (a
   * repeated header like `Set-Cookie` stays an array; spreading it, as
   * below, preserves that — never comma-join it back into a string).
   * Return a partial `{ status?, statusMessage?, headers?, body? }`.
   */
  beforeResponse(req, res) {
    let body = res.body.toString('utf8');
    try {
      const parsed = JSON.parse(body);
      parsed.rewrittenBy = 'detour-script';
      body = JSON.stringify(parsed);
    } catch {
      // Not JSON (or empty) — leave the body untouched, only tag the headers.
    }
    return {
      headers: { ...res.headers, 'x-detour-script': 'before-response' },
      body,
    };
  },
};
