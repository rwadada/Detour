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

/**
 * Rewrites a request URL's path (the part before the query string, e.g.
 * `/users/1` in `/users/1?x=2`), which is how a path *parameter* like the
 * `1` above gets changed — `query` only ever touches what comes after `?`.
 * `set` (if present) replaces the whole pathname outright and skips
 * `replace`; otherwise `replace` runs as sequential find/replace passes,
 * same semantics as `BodyReplace` (regex supported, with capture groups
 * usable in `replacement`, e.g. `find: "/users/(\\d+)"`, `replacement:
 * "/people/$1"`). The query string, if any, is left untouched either way.
 */
export interface PathRewrite {
  set?: string;
  replace?: BodyReplace[];
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
   * useful for testing a client's own error handling (other proxy tools'
   * local-response-mocking features tend to offer the same pair of
   * options). Wins over `status`/`statusMessage`/
   * `headers`/`body`/`bodyFile`, which are ignored when set.
   *
   * `'close'`: drops the connection immediately, no response at all — the
   * client sees it the same as a server that crashed mid-request.
   *
   * `'timeout'`: does nothing at all. The connection is left open and the
   * client hangs until it hits its own read/request timeout.
   */
  simulate?: 'timeout' | 'close';
  /**
   * A sequence of response overrides, consumed one per match of this rule —
   * the 1st matching request gets `responses[0]`, the 2nd gets
   * `responses[1]`, and so on; once exhausted, every further match keeps
   * reusing the last entry. Lets a stateful multi-step scenario (issue
   * #181 — e.g. a list endpoint that must reflect an item a prior request
   * just "added") be declared upfront instead of requiring the test
   * harness to rewrite rules.json at exactly the right moment between
   * requests.
   *
   * Each step overrides only the fields it sets; anything it omits falls
   * back to this action's own top-level `status`/`statusMessage`/
   * `headers`/`body`/`bodyFile`/`delayMs`/`simulate` — so a step that only
   * varies the body doesn't need to repeat the rest. Two groups are each
   * cleared wholesale rather than inherited field-by-field, so they can
   * never mix between the base action and a step (or leak an unintended
   * field from one into the other): a step setting any of `status`/
   * `statusMessage`/`headers`/`body`/`bodyFile` clears an inherited
   * `simulate` (otherwise it would silently keep winning downstream —
   * `simulate` always wins over a response when both are set — and the
   * step's override would never take effect), and a step setting
   * `simulate` clears all five of those. Within the response side,
   * `body`/`bodyFile` are themselves such a pair (`bodyFile` wins over
   * `body`), cleared the same way. `delayMs` sits outside both groups —
   * it composes with either. See `pickMockAction`.
   *
   * The call count is kept in memory only (per `Rule` object — see
   * `RuleEngine`) and always resets to 0 on the next `rules.json` reload,
   * so a fresh reload restarts the scenario at `responses[0]`.
   */
  responses?: MockStep[];
}

/** One entry in a `mock` action's `responses` sequence — see `MockAction.responses`'s doc comment. */
export type MockStep = Omit<MockAction, 'type' | 'responses'>;

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
    /** Rewrites the request URL's path, e.g. to change a path parameter. Response has no URL, so this only applies to requests. */
    path?: PathRewrite;
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

/**
 * Runs a user-authored Node.js module's `beforeRequest`/`beforeResponse`
 * hooks for transformations the declarative `rewrite` action can't express
 * (issue #9) — the hooks get the full request/response (headers *and*
 * body) and can run arbitrary JS to decide what, if anything, to change.
 * See domain/rules/scriptAction.ts for the exact hook contract.
 */
export interface ScriptAction {
  type: 'script';
  /**
   * Path to a CommonJS module (relative to rules.json) exporting
   * `beforeRequest`/`beforeResponse`, e.g.
   * `module.exports = { beforeRequest(req) { ... } }`. Reloaded
   * automatically when the file changes, same as rules.json itself.
   */
  path: string;
}

export type RuleAction = MockAction | RouteAction | RewriteAction | BreakpointAction | ScriptAction;

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
  /**
   * Best-effort marker recording which saved rule profile (issue #19's
   * Rules Profiles) was last applied/saved-as onto this file — Detour never
   * actually verifies the content still equals that profile's, so this is
   * a claim about provenance, not a guarantee about current equality.
   *
   * Only ever set by `RuleEngine.write()`'s `activeProfile` option, whose
   * only callers are `applyRuleProfile`/`saveActiveRulesAsProfile` in
   * `dashboardServer.ts`. The dashboard's Rules editor "Save to rules.json"
   * goes through the same `write()` *without* that option, which reliably
   * clears it (a plain edit is a different, unnamed ruleset even if its
   * content happens to still look the same) — but a hand-edit made outside
   * Detour entirely (a text editor saving the file directly, bypassing
   * `write()`) isn't covered by that at all: if the field was already
   * present, nothing strips or re-validates it, so it keeps being reported
   * as "active" regardless of what the hand-edit actually changed. Purely
   * informational either way — never read by the rule-matching engine
   * itself.
   */
  $activeProfile?: string;
  rules: Rule[];
}
