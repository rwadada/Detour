import { describe, expect, it } from 'vitest';
import { connectMatchUrl, formatHostPort, isHostFocused, normalizeFocusHosts } from './focusPolicy';

describe('formatHostPort', () => {
  it('omits the port when it is the scheme default', () => {
    expect(formatHostPort('example.com', 443, 443)).toBe('example.com');
  });

  it('appends the port when it differs from the default', () => {
    expect(formatHostPort('example.com', 8443, 443)).toBe('example.com:8443');
  });
});

describe('connectMatchUrl', () => {
  it('builds an https origin URL, omitting the default port', () => {
    expect(connectMatchUrl('example.com', 443)).toBe('https://example.com');
    expect(connectMatchUrl('example.com', 8443)).toBe('https://example.com:8443');
  });
});

describe('normalizeFocusHosts', () => {
  it('trims, lowercases, and dedupes, dropping empty entries', () => {
    expect(normalizeFocusHosts([' Example.com ', 'example.com', '', '  '])).toEqual(['example.com']);
  });
});

describe('isHostFocused', () => {
  it('treats an empty list as unrestricted', () => {
    expect(isHostFocused([], 'anything.example.com')).toBe(true);
  });

  it('matches a glob pattern case-insensitively', () => {
    expect(isHostFocused(['*.example.com'], 'API.example.com')).toBe(true);
    expect(isHostFocused(['*.example.com'], 'other.com')).toBe(false);
  });
});
