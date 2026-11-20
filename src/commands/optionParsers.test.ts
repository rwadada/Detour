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

  it('rejects a URL, a path, or patterns joined by something other than a comma — none could ever match a host', () => {
    expect(() => parseHostPatternList('https://api.example.com', '--focus')).toThrow(/a URL or a path/);
    expect(() => parseHostPatternList('ok.example, api.example.com/v1', '--focus')).toThrow(/"api\.example\.com\/v1"/);
    expect(() => parseHostPatternList('a.example b.example', '--focus')).toThrow(/separate patterns with commas/);
    expect(() => parseHostPatternList('a.example;b.example', '--focus')).toThrow(/separate patterns with commas/);
  });

  it('accepts globs, ports and IP literals', () => {
    expect(parseHostPatternList('*.example.net,api-1.example.com:8443,10.0.0.?,[::1]:8080', '--focus')).toEqual([
      '*.example.net',
      'api-1.example.com:8443',
      '10.0.0.?',
      '[::1]:8080',
    ]);
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

  it('points `--focus off` at --no-focus instead of taking "off" as a host', () => {
    expect(() => collectFocusPatterns(' OFF ', undefined)).toThrow(/use --no-focus/);
  });
});
