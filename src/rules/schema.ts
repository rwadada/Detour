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
        urlRegexFlags: { type: 'string' },
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
          properties: { headers: headerRewriteSchema, body: bodyRewriteSchema },
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
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateFn = ajv.compile(RULES_JSON_SCHEMA);

function formatAjvError(err: ErrorObject): string {
  const at = err.instancePath || '(root)';
  return `${at}: ${err.message ?? '不正な値です'}`;
}

/** Rules a schema alone can't express (duplicate names, ambiguous mock body). */
function validateSemantics(data: RulesFile): string[] {
  const errors: string[] = [];
  const seenNames = new Set<string>();
  for (const [index, rule] of data.rules.entries()) {
    const label = rule?.name ? `"${rule.name}"` : `#${index}`;
    if (rule.name) {
      if (seenNames.has(rule.name)) {
        errors.push(`rules[${index}] (${label}): ルール名が重複しています`);
      }
      seenNames.add(rule.name);
    }
    if (rule.action?.type === 'mock' && rule.action.body !== undefined && rule.action.bodyFile !== undefined) {
      errors.push(`rules[${index}] (${label}): action.body と action.bodyFile は同時に指定できません`);
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
