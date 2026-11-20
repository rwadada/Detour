import { describe, expect, it } from 'vitest';
import { collectFocusPatterns, parseHostPatternList } from './optionParsers';

describe('parseHostPatternList (issue #301)', () => {
  it('splits a comma-separated list, trimming and dropping empty entries', () => {
    expect(parseHostPatternList(' api.example.com, ,*.example.net ', '--focus')).toEqual([
      'api.example.com',
      '*.example.net',
    ]);
  });

  it('rejects a value with no pattern at all instead of meaning "Focus off"', () => {
    expect(() => parseHostPatternList(' , ', '--focus')).toThrow(/--focus needs at least one host pattern/);
  });

  it('rejects a URL or a path, which could never match a host', () => {
    expect(() => parseHostPatternList('https://api.example.com', '--focus')).toThrow(/not URLs or paths/);
    expect(() => parseHostPatternList('ok.example, api.example.com/v1', '--focus')).toThrow(/"api\.example\.com\/v1"/);
  });
});

describe('collectFocusPatterns (issue #301)', () => {
  it('accumulates repeated --focus values', () => {
    const first = collectFocusPatterns('a.com', undefined);
    expect(collectFocusPatterns('b.com,c.com', first)).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('starts a fresh list after an earlier --no-focus', () => {
    expect(collectFocusPatterns('a.com', false)).toEqual(['a.com']);
  });
});
