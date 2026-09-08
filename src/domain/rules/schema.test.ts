import { describe, expect, it } from 'vitest';
import { validateRulesData } from './schema';

function baseRule(overrides: Record<string, unknown> = {}) {
  return {
    name: 'r1',
    match: { url: 'https://api.example.com/*' },
    action: { type: 'mock', status: 200 },
    ...overrides,
  };
}

describe('validateRulesData', () => {
  it('accepts a minimal valid rules file', () => {
    const result = validateRulesData({ rules: [baseRule()] });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('accepts an empty rules array', () => {
    expect(validateRulesData({ rules: [] }).valid).toBe(true);
  });

  it('rejects a document missing the top-level `rules` array', () => {
    const result = validateRulesData({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a match block with neither url nor urlRegex', () => {
    const result = validateRulesData({ rules: [baseRule({ match: {} })] });
    expect(result.valid).toBe(false);
  });

  it('rejects an action whose type is not one of mock/route/rewrite/breakpoint', () => {
    const result = validateRulesData({ rules: [baseRule({ action: { type: 'bogus' } })] });
    expect(result.valid).toBe(false);
  });

  it('reports duplicate rule names as a semantic error', () => {
    const result = validateRulesData({ rules: [baseRule({ name: 'dup' }), baseRule({ name: 'dup' })] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate rule name'))).toBe(true);
  });

  it('rejects a mock action with both body and bodyFile set', () => {
    const result = validateRulesData({
      rules: [baseRule({ action: { type: 'mock', body: { a: 1 }, bodyFile: 'x.json' } })],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('body and action.bodyFile'))).toBe(true);
  });

  it('rejects a mock action combining simulate with body', () => {
    const result = validateRulesData({
      rules: [baseRule({ action: { type: 'mock', simulate: 'close', body: 'x' } })],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('action.simulate cannot be combined'))).toBe(true);
  });

  it('accepts a route action', () => {
    const result = validateRulesData({
      rules: [baseRule({ action: { type: 'route', host: 'staging.example.com', port: 443 } })],
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a rewrite action touching request and response', () => {
    const result = validateRulesData({
      rules: [
        baseRule({
          action: {
            type: 'rewrite',
            request: { headers: { set: { 'X-Detour': '1' } } },
            response: { status: 201, body: { merge: { ok: true } } },
          },
        }),
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a script action', () => {
    const result = validateRulesData({
      rules: [baseRule({ action: { type: 'script', path: './rules.script.js' } })],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a script action missing path', () => {
    const result = validateRulesData({ rules: [baseRule({ action: { type: 'script' } })] });
    expect(result.valid).toBe(false);
  });

  it('rejects a script action with an empty path', () => {
    const result = validateRulesData({ rules: [baseRule({ action: { type: 'script', path: '' } })] });
    expect(result.valid).toBe(false);
  });

  it('rejects a script action with unknown extra properties', () => {
    const result = validateRulesData({
      rules: [baseRule({ action: { type: 'script', path: './x.js', bogus: true } })],
    });
    expect(result.valid).toBe(false);
  });

  it('accepts a breakpoint action with only one phase enabled', () => {
    const result = validateRulesData({ rules: [baseRule({ action: { type: 'breakpoint', response: false } })] });
    expect(result.valid).toBe(true);
  });

  it('rejects a breakpoint action with both phases disabled', () => {
    const result = validateRulesData({
      rules: [baseRule({ action: { type: 'breakpoint', request: false, response: false } })],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('never pause anything'))).toBe(true);
  });

  it('rejects an invalid urlRegex pattern', () => {
    const result = validateRulesData({ rules: [baseRule({ match: { urlRegex: '(unterminated' } })] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invalid urlRegex/urlRegexFlags'))).toBe(true);
  });

  it('rejects an invalid urlRegexFlags value', () => {
    const result = validateRulesData({
      rules: [baseRule({ match: { urlRegex: '.*', urlRegexFlags: 'q' } })],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects urlRegexFlags with a duplicated flag (schema allows it, RegExp does not)', () => {
    const result = validateRulesData({
      rules: [baseRule({ match: { urlRegex: '.*', urlRegexFlags: 'ii' } })],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('invalid urlRegex/urlRegexFlags'))).toBe(true);
  });

  it('accepts a valid urlRegex with valid flags', () => {
    const result = validateRulesData({
      rules: [baseRule({ match: { urlRegex: '^/api/.*$', urlRegexFlags: 'i' } })],
    });
    expect(result.valid).toBe(true);
  });

  it('collects every validation error rather than stopping at the first', () => {
    const result = validateRulesData({
      rules: [baseRule({ name: 'dup' }), baseRule({ name: 'dup', action: { type: 'bogus' } })],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});
