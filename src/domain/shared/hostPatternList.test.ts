import { describe, expect, it } from 'vitest';
import { matchesAnyHostPattern, normalizeHostPatterns } from './hostPatternList';

describe('normalizeHostPatterns', () => {
  it('trims, lowercases, and dedupes, dropping empty entries', () => {
    expect(normalizeHostPatterns([' Example.com ', 'example.com', '', '  '])).toEqual(['example.com']);
  });
});

describe('matchesAnyHostPattern', () => {
  it('returns false against an empty pattern list', () => {
    expect(matchesAnyHostPattern([], 'anything.example.com')).toBe(false);
  });

  it('matches a glob pattern case-insensitively', () => {
    expect(matchesAnyHostPattern(['*.example.com'], 'API.example.com')).toBe(true);
    expect(matchesAnyHostPattern(['*.example.com'], 'other.com')).toBe(false);
  });
});
