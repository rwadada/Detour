import Ajv, { type ErrorObject } from 'ajv';
import { MATCH_JSON_SCHEMA } from './matchSchema';
import type { BodyReplace, Rule, RulesFile } from './types';

const headerRewriteSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    set: { type: 'object', additionalProperties: { type: 'string' } },
    remove: { type: 'array', items: { type: 'string' } },
  },
};

const queryRewriteSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    set: { type: 'object', additionalProperties: { type: 'string' } },
    remove: { type: 'array', items: { type: 'string' } },
  },
};

const bodyReplaceSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['find', 'replacement'],
    properties: {
      find: { type: 'string' },
      replacement: { type: 'string' },
      regex: { type: 'boolean' },
      // Catches obvious typos at the schema stage, same as match.urlRegexFlags
      // above; `validateSemantics` below still compiles `find`/`flags` (when
      // `regex` is set) to catch flag *combinations* RegExp itself rejects
      // (e.g. duplicate flags), which this charset check alone can't.
      flags: { type: 'string', pattern: '^[dgimsuvy]*$' },
    },
  },
};

const pathRewriteSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // No schema-level charset restriction here (unlike bodyReplaceSchema's
    // `flags` above) — `applyPathRewrite` appends the request's existing
    // query string onto `set` verbatim, so a `set` that already carries a
    // "?"/"#" would produce a path with two query strings (or a stray
    // fragment); `validateSemantics` below rejects that with a message
    // naming the actual problem, which a bare ajv pattern mismatch wouldn't.
    set: { type: 'string', minLength: 1 },
    replace: bodyReplaceSchema,
  },
};

const bodyRewriteSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    set: {},
    replace: bodyReplaceSchema,
    // Merge patches only make sense as an object (RFC 7396) — a bare
    // scalar/array would just be a confusing spelling of `set`.
    merge: { type: 'object' },
  },
};

/** JSON Schema for `rules.json`. Exported mainly for `detour rules validate`/editor tooling. */
export const RULES_JSON_SCHEMA = {
  title: 'Detour rules.json',
  type: 'object',
  additionalProperties: false,
  required: ['rules'],
  properties: {
    $schema: { type: 'string' },
    // See `RulesFile.$activeProfile`'s doc comment (domain/rules/types.ts) —
    // purely informational bookkeeping for the dashboard's Rules Profiles
    // feature, not a rule-matching concern.
    $activeProfile: { type: 'string' },
    rules: { type: 'array', items: { $ref: '#/definitions/rule' } },
  },
  definitions: {
    rule: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'match', 'action'],
      properties: {
        name: { type: 'string', minLength: 1 },
        enabled: { type: 'boolean' },
        match: { $ref: '#/definitions/match' },
        action: {
          oneOf: [
            { $ref: '#/definitions/mockAction' },
            { $ref: '#/definitions/routeAction' },
            { $ref: '#/definitions/rewriteAction' },
            { $ref: '#/definitions/breakpointAction' },
            { $ref: '#/definitions/scriptAction' },
          ],
        },
      },
    },
    match: {
      ...MATCH_JSON_SCHEMA,
      // A rewrite/mock/route rule needs a decisive target to act on, unlike
      // a `detour test` assertion's own use of this same fragment (see
      // `MATCH_JSON_SCHEMA`'s doc comment) — `validateSemantics` below still
      // compiles `urlRegex`/`urlRegexFlags` to catch flag *combinations*
      // RegExp itself rejects (e.g. duplicate flags) and invalid patterns
      // this schema-level check alone can't.
      oneOf: [{ required: ['url'] }, { required: ['urlRegex'] }],
    },
    mockAction: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'mock' },
        status: { type: 'integer', minimum: 100, maximum: 599 },
        statusMessage: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: {},
        bodyFile: { type: 'string', minLength: 1 },
        delayMs: { type: 'integer', minimum: 0 },
        simulate: { enum: ['timeout', 'close'] },
      },
    },
    routeAction: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'host'],
      properties: {
        type: { const: 'route' },
        host: { type: 'string', minLength: 1 },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        preserveHostHeader: { type: 'boolean' },
      },
    },
    rewriteAction: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'rewrite' },
        request: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: pathRewriteSchema,
            query: queryRewriteSchema,
            headers: headerRewriteSchema,
            body: bodyRewriteSchema,
          },
        },
        response: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'integer', minimum: 100, maximum: 599 },
            headers: headerRewriteSchema,
            body: bodyRewriteSchema,
          },
        },
      },
    },
    breakpointAction: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: { const: 'breakpoint' },
        request: { type: 'boolean' },
        response: { type: 'boolean' },
      },
    },
    scriptAction: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'path'],
      properties: {
        type: { const: 'script' },
        path: { type: 'string', minLength: 1 },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateFn = ajv.compile(RULES_JSON_SCHEMA);

function formatAjvError(err: ErrorObject): string {
  const at = err.instancePath || '(root)';
  return `${at}: ${err.message ?? 'invalid value'}`;
}

/**
 * Compiles each `regex: true` replace step's `find`/`flags`, appending a
 * labeled error for any RegExp the schema's charset-only `flags` pattern
 * can't catch (e.g. duplicate flags like `"gg"`) — same reasoning as
 * `match.urlRegex`'s compile check below.
 */
function validateReplaceSteps(
  steps: BodyReplace[] | undefined,
  index: number,
  label: string,
  location: string,
  errors: string[],
): void {
  for (const [stepIndex, step] of (steps ?? []).entries()) {
    if (!step.regex) continue;
    try {
      new RegExp(step.find, step.flags);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(`rules[${index}] (${label}): invalid ${location}.replace[${stepIndex}] regex/flags: ${reason}`);
    }
  }
}

/** Rules a schema alone can't express (duplicate names, ambiguous mock body). */
function validateSemantics(data: RulesFile): string[] {
  const errors: string[] = [];
  const seenNames = new Set<string>();
  for (const [index, rule] of data.rules.entries()) {
    const label = rule?.name ? `"${rule.name}"` : `#${index}`;
    if (rule.name) {
      if (seenNames.has(rule.name)) {
        errors.push(`rules[${index}] (${label}): duplicate rule name`);
      }
      seenNames.add(rule.name);
    }
    if (rule.action?.type === 'mock' && rule.action.body !== undefined && rule.action.bodyFile !== undefined) {
      errors.push(`rules[${index}] (${label}): action.body and action.bodyFile cannot both be set`);
    }
    if (
      rule.action?.type === 'mock' &&
      rule.action.simulate !== undefined &&
      (rule.action.body !== undefined || rule.action.bodyFile !== undefined)
    ) {
      errors.push(`rules[${index}] (${label}): action.simulate cannot be combined with action.body/action.bodyFile`);
    }
    if (rule.action?.type === 'breakpoint' && rule.action.request === false && rule.action.response === false) {
      errors.push(
        `rules[${index}] (${label}): action.request and action.response cannot both be false — this breakpoint would never pause anything`,
      );
    }
    // Catches the natural mistake of typing "host:port" into action.host
    // (there's a separate action.port field for that) — left unvalidated,
    // this reaches net/http as a literal hostname, so it fails DNS
    // resolution (`getaddrinfo ENOTFOUND host:port`) instead of connecting.
    // A single colon followed by only digits is host:port almost by
    // definition; a bare IPv6 literal (`::1`, two-plus colons, no
    // brackets — the *correct* way to spell this field, per the next
    // check below) never matches, since splitting on its last colon would
    // wrongly treat part of the address as a port.
    if (rule.action?.type === 'route' && /^[^:]+:\d+$/.test(rule.action.host)) {
      errors.push(
        `rules[${index}] (${label}): action.host "${rule.action.host}" looks like it includes a port — put the port in action.port instead, action.host must be a bare host (hostname or IP) without a port`,
      );
    }
    // A bracketed IPv6 literal (`[::1]`, `[::1]:8080`) is how a URL or
    // Host header pairs an IPv6 address with an explicit port —
    // `ProxyEngine.parseHost` unwraps exactly that form when parsing an
    // *inbound* request. `computeRouteTarget`/`applyRouteAction` don't:
    // action.host reaches `http.request`'s own `host` option verbatim for
    // the *outbound* connection, so a bracketed value would try to
    // resolve a host literally named "[::1]", brackets and all, and fail.
    // Rejects a bare `[` or `]` anywhere in the string, not just a
    // well-formed `[...]` pair — neither character is ever legal in a real
    // hostname or IP literal, so a malformed one missing its closing
    // bracket (a typo trimming "[::1]" down to "[::1") is exactly as
    // broken as the well-formed case, and matching only the paired form
    // would let it slip through unflagged. The working spelling is the
    // bare, unbracketed literal (`::1`), with any port in action.port
    // instead — same as the check above, just for IPv6's own RFC 3986
    // pairing syntax rather than the plain host:port one.
    if (rule.action?.type === 'route' && /[[\]]/.test(rule.action.host)) {
      errors.push(
        `rules[${index}] (${label}): action.host "${rule.action.host}" must be a bare host without brackets — bracketed IPv6 (e.g. "[::1]") isn't unwrapped for an outbound connection, use "::1" instead, with any port in action.port`,
      );
    }
    if (rule.match?.urlRegex !== undefined) {
      try {
        new RegExp(rule.match.urlRegex, rule.match.urlRegexFlags);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        errors.push(`rules[${index}] (${label}): invalid urlRegex/urlRegexFlags: ${reason}`);
      }
    }
    if (rule.action?.type === 'rewrite') {
      const pathSet = rule.action.request?.path?.set;
      // See pathRewriteSchema's `set` doc comment (schema.ts above) for why
      // this isn't a schema-level pattern instead.
      if (pathSet !== undefined && /[?#]/.test(pathSet)) {
        errors.push(
          `rules[${index}] (${label}): action.request.path.set "${pathSet}" must not contain "?"/"#" — the request's existing query string is preserved and appended automatically, so path.set must be a bare pathname`,
        );
      }
      // A pathname sent as an HTTP request-target must start with "/" (RFC
      // 7230 origin-form) — omitting it (e.g. "people/1") would reach
      // net/http as a malformed request line to the upstream server.
      if (pathSet !== undefined && !pathSet.startsWith('/')) {
        errors.push(
          `rules[${index}] (${label}): action.request.path.set "${pathSet}" must start with "/" — it replaces the request's URL path, which always begins with "/"`,
        );
      }
      validateReplaceSteps(rule.action.request?.path?.replace, index, label, 'action.request.path', errors);
      validateReplaceSteps(rule.action.request?.body?.replace, index, label, 'action.request.body', errors);
      validateReplaceSteps(rule.action.response?.body?.replace, index, label, 'action.response.body', errors);
    }
  }
  return errors;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validates a parsed `rules.json` document against the schema and Detour's semantic rules. */
export function validateRulesData(data: unknown): ValidationResult {
  const schemaValid = validateFn(data);
  const errors = schemaValid ? [] : (validateFn.errors ?? []).map(formatAjvError);
  if (schemaValid) {
    errors.push(...validateSemantics(data as RulesFile));
  }
  return { valid: errors.length === 0, errors };
}

export type { Rule };
