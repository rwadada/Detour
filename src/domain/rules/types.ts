/**
 * Types for `rules.json`: Detour's declarative rule engine.
 *
 * A rules file is a list of rules, evaluated in file order. The first
 * enabled rule whose `match` criteria are satisfied by a request wins;
 * its `action` decides what happens to that request (see actions.ts).
 */

/** Selects which requests a rule applies to. */
export interface RuleMatch {
  /** HTTP method(s) to match (case-insensitive). Omit to match any method. */
  method?: string | string[];
  /**
   * Wildcard pattern matched against the request's fully-qualified URL
   * (e.g. `https://api.example.com/users/1?x=2`). `*` matches any run of
   * characters (including none), `?` matches exactly one character.
   * Exactly one of `url`/`urlRegex` must be set.
   */
  url?: string;
  /**
   * Regular expression (source only, no slash delimiters) matched
   * against the same fully-qualified URL as `url`. Exactly one of
   * `url`/`urlRegex` must be set.
   */
  urlRegex?: string;
  /** Flags for `urlRegex`, e.g. `"i"`. Ignored unless `urlRegex` is set. */
  urlRegexFlags?: string;
}

/** Adds/removes headers. `set` is applied after `remove`. */
export interface HeaderRewrite {
  set?: Record<string, string>;
  remove?: string[];
}

/** Adds/removes URL query string parameters. `set` is applied after `remove`. */
export interface QueryRewrite {
  set?: Record<string, string>;
  remove?: string[];
}

/** A single textual find/replace applied to a body. */
export interface BodyReplace {
  find: string;
  replacement: string;
  /** Treat `find` as a regular expression source instead of a literal substring. */
  regex?: boolean;
  /** Flags for the regular expression (only used when `regex` is true). Defaults to `"g"`. */
  flags?: string;
}

/**
 * Rewrites a request/response body. Steps combine as: `set` (if present) replaces
 * the body outright and skips the rest; otherwise `replace` runs first, then
 * `merge` is applied to the result.
 */
export interface BodyRewrite {
  /** Replaces the whole body. Objects/arrays are JSON-serialized; strings are sent verbatim. Wins over `replace`/`merge`. */
  set?: unknown;
  /** Sequential find/replace passes applied to the body as text. */
  replace?: BodyReplace[];
  /**
   * JSON Merge Patch (RFC 7396) applied to the body parsed as JSON: each key
   * in `merge` overwrites (recursively, for nested objects) the same key in
   * the body, and a `null` value deletes that key. Arrays are replaced
   * wholesale, not merged element-by-element. If the body isn't valid JSON,
   * it's treated as an empty object before merging.
   */
  merge?: unknown;
}

export interface MockAction {
  type: 'mock';
  status?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  /** Response body. Objects/arrays are JSON-serialized; strings are sent verbatim. */
  body?: unknown;
  /** Path to a file (relative to rules.json) whose contents become the response body. Wins over `body`. */
  bodyFile?: string;
  /** Artificial delay before responding, in milliseconds. Also delays `simulate`, if set. */
  delayMs?: number;
  /**
   * Simulates a broken connection instead of ever sending a response —
   * useful for testing a client's own error handling (Charles' "Map Local"
   * has the same pair of options). Wins over `status`/`statusMessage`/
   * `headers`/`body`/`bodyFile`, which are ignored when set.
   *
   * `'close'`: drops the connection immediately, no response at all — the
   * client sees it the same as a server that crashed mid-request.
   *
   * `'timeout'`: does nothing at all. The connection is left open and the
   * client hangs until it hits its own read/request timeout.
   */
  simulate?: 'timeout' | 'close';
}

export interface RouteAction {
  type: 'route';
  /** Host/IP the request is actually sent to, in place of the one it was addressed to. */
  host: string;
  /** Port to connect to. Defaults to the request's original port. */
  port?: number;
  /**
   * Keep the original `Host` header (and TLS SNI, already fixed by the time
   * this runs) so the new destination still sees the request as addressed
   * to the original host. Defaults to true.
   */
  preserveHostHeader?: boolean;
}

export interface RewriteAction {
  type: 'rewrite';
  request?: {
    /** Rewrites the request URL's query string. Response has no URL, so this only applies to requests. */
    query?: QueryRewrite;
    headers?: HeaderRewrite;
    body?: BodyRewrite;
  };
  response?: {
    status?: number;
    headers?: HeaderRewrite;
    body?: BodyRewrite;
  };
}

/**
 * Pauses a matching exchange for interactive inspection/editing from the
 * dashboard, instead of letting it flow straight through. `request`/`response`
 * independently control which phase(s) pause; each paused phase waits
 * (indefinitely — there's no timeout) for the dashboard to resume or abort it.
 */
export interface BreakpointAction {
  type: 'breakpoint';
  /**
   * Pause before the request is forwarded upstream, exposing method/path/
   * headers/body for editing from the dashboard. Defaults to true.
   */
  request?: boolean;
  /**
   * Pause once the upstream response has fully arrived, exposing status/
   * headers/body for editing from the dashboard before it's returned to the
   * client. Defaults to true.
   */
  response?: boolean;
}

export type RuleAction = MockAction | RouteAction | RewriteAction | BreakpointAction;

export interface Rule {
  name: string;
  /** Defaults to true. */
  enabled?: boolean;
  match: RuleMatch;
  action: RuleAction;
}

export interface RulesFile {
  /** Optional `$schema` pointer for editor tooling; ignored by Detour itself. */
  $schema?: string;
  rules: Rule[];
}
