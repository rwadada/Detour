import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readPersistedState, writePersistedState } from './persistedState';

// A minimal in-memory `localStorage` stand-in — this project's vitest
// config runs `environment: 'node'`, which has no `localStorage` global.
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe('readPersistedState / writePersistedState', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage());
  });

  it('round-trips a value written and then read back', () => {
    writePersistedState('k', { a: 1, b: ['x', 'y'] });
    expect(readPersistedState('k', null)).toEqual({ a: 1, b: ['x', 'y'] });
  });

  it('returns the fallback when the key has never been written', () => {
    expect(readPersistedState('missing', 'fallback')).toBe('fallback');
  });

  it('returns the fallback for corrupt (non-JSON) stored data, without throwing', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'not json', setItem: () => {} });
    expect(readPersistedState('k', 'fallback')).toBe('fallback');
  });

  it('returns the fallback rather than throwing when localStorage.getItem itself throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
    });
    expect(readPersistedState('k', 'fallback')).toBe('fallback');
  });

  it('does not throw when localStorage.setItem itself throws (e.g. quota exceeded)', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota exceeded');
      },
    });
    expect(() => writePersistedState('k', 'v')).not.toThrow();
  });
});
