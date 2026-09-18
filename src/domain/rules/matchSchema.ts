/**
 * Shared JSON Schema fragment for matching a request by method/url/urlRegex
 * — used as-is by `rules.json`'s `match` (domain/rules/schema.ts, which adds
 * its own `oneOf: [{ required: ['url'] }, { required: ['urlRegex'] }]` on
 * top, since a rewrite/mock/route rule needs a decisive target) and by a
 * `detour test` assertion's `match` (domain/test/schema.ts, which doesn't —
 * an assertion with neither is a deliberate "check every exchange" match).
 */
export const MATCH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // `minLength: 1` on both branches matters beyond the usual "reject an
    // empty string": `normalizeMethods` (domain/rules/matcher.ts) treats a
    // falsy `method` as "no filter", so a schema that allowed `""` here
    // would let a typo like `"method": ""` silently widen a match to every
    // method instead of failing validation.
    method: {
      oneOf: [
        { type: 'string', minLength: 1 },
        { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
      ],
    },
    url: { type: 'string', minLength: 1 },
    urlRegex: { type: 'string', minLength: 1 },
    urlRegexFlags: { type: 'string', pattern: '^[dgimsuvy]*$' },
  },
} as const;
