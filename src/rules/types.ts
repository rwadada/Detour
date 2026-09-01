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

/** A single textual find/replace applied to a body. */
export interface BodyReplace {
  find: string;
  replacement: string;
  /** Treat `find` as a regular expression source instead of a literal substring. */
  regex?: boolean;
  /** Flags for the regular expression (only used when `regex` is true). Defaults to `"g"`. */
  flags?: string;
}

/** Rewrites a request/response body. `set` wins over `replace` when both are present. */
export interface BodyRewrite {
  /** Replaces the whole body. Objects/arrays are JSON-serialized; strings are sent verbatim. */
  set?: unknown;
  /** Sequential find/replace passes applied to the body as text. */
  replace?: BodyReplace[];
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
  /** Artificial delay before responding, in milliseconds. */
  delayMs?: number;
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
    headers?: HeaderRewrite;
    body?: BodyRewrite;
  };
  response?: {
    status?: number;
    headers?: HeaderRewrite;
    body?: BodyRewrite;
  };
}

export type RuleAction = MockAction | RouteAction | RewriteAction;

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
