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

  describe('isValid', () => {
    const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

    it('returns the parsed value when it passes isValid', () => {
      writePersistedState('k', true);
      expect(readPersistedState('k', false, isBoolean)).toBe(true);
    });

    // A review finding: the JSON literal `null` parses without error, so a
    // plain try/catch around JSON.parse alone can't reject it — only an
    // explicit shape check can. Same for any other well-formed-but-wrong-
    // type value (a string, a number, an object where a caller expects a
    // primitive, …).
    it.each([
      ['null', 'null'],
      ['a string', '"not-a-boolean"'],
      ['a number', '1'],
    ])('falls back to the default when the parsed value is %s but isValid rejects it', (_label, raw) => {
      vi.stubGlobal('localStorage', { getItem: () => raw, setItem: () => {} });
      expect(readPersistedState('k', false, isBoolean)).toBe(false);
    });

    it('is not consulted when the key was never written (fallback path short-circuits first)', () => {
      let calls = 0;
      const isValid = (v: unknown): v is boolean => {
        calls++;
        return isBoolean(v);
      };
      readPersistedState<boolean>('missing', false, isValid);
      expect(calls).toBe(0);
    });
  });
});
