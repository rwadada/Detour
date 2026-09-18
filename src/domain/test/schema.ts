import Ajv, { type ErrorObject } from 'ajv';
import { MATCH_JSON_SCHEMA } from '../rules/matchSchema';
import type { TestAssertion, TestFile } from './types';

/** JSON Schema for a `detour test` assertions file. Exported for `validateTestData`/`loadTestFile` below, and for any future editor/tooling support (there's no `detour test validate` subcommand — `detour test` itself validates the assertions file eagerly before running). */
export const TEST_JSON_SCHEMA = {
  title: 'Detour test assertions',
  type: 'object',
  additionalProperties: false,
  required: ['assertions'],
  properties: {
    $schema: { type: 'string' },
    assertions: { type: 'array', items: { $ref: '#/definitions/assertion' } },
  },
  definitions: {
    assertion: {
      oneOf: [
        { $ref: '#/definitions/headerPresent' },
        { $ref: '#/definitions/noPiiLeak' },
        { $ref: '#/definitions/latencyP95' },
      ],
    },
    headerPresent: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'name', 'match', 'header'],
      properties: {
        type: { const: 'headerPresent' },
        name: { type: 'string', minLength: 1 },
        match: MATCH_JSON_SCHEMA,
        phase: { enum: ['request', 'response'] },
        header: { type: 'string', minLength: 1 },
        allowNoMatches: { type: 'boolean' },
      },
    },
    noPiiLeak: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'name', 'match'],
      properties: {
        type: { const: 'noPiiLeak' },
        name: { type: 'string', minLength: 1 },
        match: MATCH_JSON_SCHEMA,
        patterns: { type: 'array', items: { enum: ['email', 'creditCard', 'ssn'] }, minItems: 1 },
        customPatterns: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
      },
    },
    latencyP95: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'name', 'match', 'maxMs'],
      properties: {
        type: { const: 'latencyP95' },
        name: { type: 'string', minLength: 1 },
        match: MATCH_JSON_SCHEMA,
        maxMs: { type: 'number', exclusiveMinimum: 0 },
        allowNoMatches: { type: 'boolean' },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateFn = ajv.compile(TEST_JSON_SCHEMA);

function formatAjvError(err: ErrorObject): string {
  const at = err.instancePath || '(root)';
  return `${at}: ${err.message ?? 'invalid value'}`;
}

/** Rules a schema alone can't express (duplicate names, an invalid regex). */
function validateSemantics(data: TestFile): string[] {
  const errors: string[] = [];
  const seenNames = new Set<string>();
  for (const [index, assertion] of data.assertions.entries()) {
    const label = assertion?.name ? `"${assertion.name}"` : `#${index}`;
    if (assertion.name) {
      if (seenNames.has(assertion.name)) errors.push(`assertions[${index}] (${label}): duplicate assertion name`);
      seenNames.add(assertion.name);
    }
    if (assertion.match?.urlRegex !== undefined) {
      try {
        new RegExp(assertion.match.urlRegex, assertion.match.urlRegexFlags);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        errors.push(`assertions[${index}] (${label}): invalid match.urlRegex/urlRegexFlags: ${reason}`);
      }
    }
    if (assertion.type === 'noPiiLeak') {
      for (const [patternIndex, source] of (assertion.customPatterns ?? []).entries()) {
        try {
          new RegExp(source, 'i');
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          errors.push(`assertions[${index}] (${label}): invalid customPatterns[${patternIndex}]: ${reason}`);
        }
      }
    }
  }
  return errors;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validates a parsed `detour test` assertions document against the schema and Detour's semantic rules. */
export function validateTestData(data: unknown): ValidationResult {
  const schemaValid = validateFn(data);
  const errors = schemaValid ? [] : (validateFn.errors ?? []).map(formatAjvError);
  if (schemaValid) {
    errors.push(...validateSemantics(data as TestFile));
  }
  return { valid: errors.length === 0, errors };
}

export type { TestAssertion };
