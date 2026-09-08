import Ajv, { type ErrorObject } from 'ajv';
import type { Rule, RulesFile } from './types';

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

const bodyRewriteSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    set: {},
    replace: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['find', 'replacement'],
        properties: {
          find: { type: 'string' },
          replacement: { type: 'string' },
          regex: { type: 'boolean' },
          flags: { type: 'string' },
        },
      },
    },
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
      type: 'object',
      additionalProperties: false,
      properties: {
        method: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
        },
        url: { type: 'string', minLength: 1 },
        urlRegex: { type: 'string', minLength: 1 },
        // Catches obvious typos at the schema stage; `validateSemantics` below
        // still compiles the regex to catch flag *combinations* RegExp itself
        // rejects (e.g. duplicate flags) and invalid `urlRegex` patterns.
        urlRegexFlags: { type: 'string', pattern: '^[dgimsuvy]*$' },
      },
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
          properties: { query: queryRewriteSchema, headers: headerRewriteSchema, body: bodyRewriteSchema },
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
    // Two shapes catch it: a single colon followed by only digits
    // (`example.com:8080`) is host:port almost by definition, and a
    // bracketed literal followed by `:digits` (`[::1]:8080`) is the
    // equivalent for IPv6 — URLs bracket an IPv6 host specifically to
    // disambiguate its own colons from a trailing :port, so anything past
    // the closing bracket is unambiguously a port, never part of the
    // address. Neither shape matches a bare IPv6 literal with no port
    // (`::1`, unbracketed and un-suffixed — the correct way to spell this
    // field when there's nothing for action.port to hold), since that has
    // either zero colons (not IPv6) or, unbracketed, at least two.
    if (
      rule.action?.type === 'route' &&
      (/^[^:]+:\d+$/.test(rule.action.host) || /^\[[^\]]*\]:\d+$/.test(rule.action.host))
    ) {
      errors.push(
        `rules[${index}] (${label}): action.host "${rule.action.host}" looks like it includes a port — put the port in action.port instead, action.host must be a bare hostname`,
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
