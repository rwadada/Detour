import { describe, expect, it } from 'vitest';
import type { Rule } from '@/shared/api';
import { blankRule, describeMatch, parseMethodInput } from './ruleSummary';

function rule(overrides: Partial<Rule> = {}): Rule {
  return { name: 'r1', match: { url: 'https://x/*' }, action: { type: 'route', host: 'y' }, ...overrides };
}

describe('describeMatch', () => {
  it('shows a single method and the url pattern', () => {
    expect(describeMatch(rule({ match: { method: 'GET', url: 'https://api.example.com/*' } }))).toBe(
      'GET https://api.example.com/*',
    );
  });

  it('defaults to ANY when no method is set', () => {
    expect(describeMatch(rule({ match: { url: 'https://x/*' } }))).toBe('ANY https://x/*');
  });

  it('joins multiple methods with a comma', () => {
    expect(describeMatch(rule({ match: { method: ['GET', 'POST'], url: 'https://x/*' } }))).toBe(
      'GET,POST https://x/*',
    );
  });

  it('falls back to the regex pattern when url is absent', () => {
    expect(describeMatch(rule({ match: { urlRegex: '^https://x/.*$', urlRegexFlags: 'i' } }))).toBe(
      'ANY /^https://x/.*$/i',
    );
  });

  it('falls back to "*" when neither url nor urlRegex is set', () => {
    expect(describeMatch(rule({ match: {} }))).toBe('ANY *');
  });
});

describe('parseMethodInput', () => {
  it('treats blank as "any method"', () => {
    expect(parseMethodInput('')).toBeUndefined();
    expect(parseMethodInput('   ')).toBeUndefined();
  });

  it('keeps a single method as a plain string', () => {
    expect(parseMethodInput('GET')).toBe('GET');
  });

  it('splits comma-separated methods, trimming each', () => {
    expect(parseMethodInput('GET, POST ,PUT')).toEqual(['GET', 'POST', 'PUT']);
  });
});

describe('blankRule', () => {
  it('produces a valid-shaped starter rule', () => {
    const b = blankRule();
    expect(b.name).toBeTruthy();
    expect(b.action.type).toBe('mock');
    expect(b.match.url).toBeTruthy();
  });
});
