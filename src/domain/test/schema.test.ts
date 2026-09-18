import { describe, expect, it } from 'vitest';
import { validateTestData } from './schema';

describe('validateTestData', () => {
  it('accepts a valid assertions file with one of each assertion type', () => {
    const result = validateTestData({
      assertions: [
        { type: 'headerPresent', name: 'a', match: { url: 'https://x/*' }, header: 'Authorization' },
        { type: 'noPiiLeak', name: 'b', match: { urlRegex: '^https://ads\\.' }, patterns: ['email'] },
        { type: 'latencyP95', name: 'c', match: { url: 'https://x/*' }, maxMs: 500 },
      ],
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects a document missing the required "assertions" key', () => {
    const result = validateTestData({});
    expect(result.valid).toBe(false);
  });

  it('rejects an empty string match.method (would otherwise silently match every method)', () => {
    const result = validateTestData({
      assertions: [{ type: 'latencyP95', name: 'a', match: { url: 'https://x/*', method: '' }, maxMs: 100 }],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown assertion type', () => {
    const result = validateTestData({ assertions: [{ type: 'bogus', name: 'a', match: {} }] });
    expect(result.valid).toBe(false);
  });

  it('rejects headerPresent missing its required "header" field', () => {
    const result = validateTestData({
      assertions: [{ type: 'headerPresent', name: 'a', match: { url: 'https://x/*' } }],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects latencyP95 with a non-positive maxMs', () => {
    const result = validateTestData({
      assertions: [{ type: 'latencyP95', name: 'a', match: { url: 'https://x/*' }, maxMs: 0 }],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects two assertions sharing the same name', () => {
    const result = validateTestData({
      assertions: [
        { type: 'latencyP95', name: 'dup', match: { url: 'https://x/*' }, maxMs: 100 },
        { type: 'latencyP95', name: 'dup', match: { url: 'https://y/*' }, maxMs: 100 },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate assertion name'))).toBe(true);
  });

  it('rejects an invalid match.urlRegex', () => {
    const result = validateTestData({
      assertions: [{ type: 'latencyP95', name: 'a', match: { urlRegex: '(' }, maxMs: 100 }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('urlRegex'))).toBe(true);
  });

  it('rejects an invalid customPatterns regex on noPiiLeak', () => {
    const result = validateTestData({
      assertions: [{ type: 'noPiiLeak', name: 'a', match: { url: 'https://x/*' }, customPatterns: ['('] }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('customPatterns'))).toBe(true);
  });

  it('rejects noPiiLeak with neither patterns nor customPatterns (can never detect anything)', () => {
    const result = validateTestData({
      assertions: [{ type: 'noPiiLeak', name: 'a', match: { url: 'https://x/*' } }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('must set at least one of patterns/customPatterns'))).toBe(true);
  });

  it('rejects urlRegexFlags set alongside url instead of urlRegex (flags would be silently ignored)', () => {
    const result = validateTestData({
      assertions: [{ type: 'latencyP95', name: 'a', match: { url: 'https://x/*', urlRegexFlags: 'i' }, maxMs: 100 }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('urlRegexFlags is set without match.urlRegex'))).toBe(true);
  });
});
