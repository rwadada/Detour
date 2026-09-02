import { describe, expect, it } from 'vitest';
import { isHostBlocked, normalizeBlockHosts } from './blockHostsPolicy';

describe('normalizeBlockHosts', () => {
  it('trims, lowercases, and dedupes, dropping empty entries', () => {
    expect(normalizeBlockHosts([' Example.com ', 'example.com', '', '  '])).toEqual(['example.com']);
  });
});

describe('isHostBlocked', () => {
  it('treats an empty list as nothing blocked', () => {
    expect(isHostBlocked([], 'anything.example.com')).toBe(false);
  });

  it('matches a glob pattern case-insensitively', () => {
    expect(isHostBlocked(['*.example.com'], 'API.example.com')).toBe(true);
    expect(isHostBlocked(['*.example.com'], 'other.com')).toBe(false);
  });

  it('matches an exact host:port pattern', () => {
    expect(isHostBlocked(['localhost:3000'], 'localhost:3000')).toBe(true);
    expect(isHostBlocked(['localhost:3000'], 'localhost:3001')).toBe(false);
  });
});
