import { describe, expect, it } from 'vitest';
import { LruMap } from './lruMap';

describe('LruMap', () => {
  it('stores and returns values like a Map', () => {
    const cache = new LruMap<string, number>(10);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.has('a')).toBe(true);
    expect(cache.has('missing')).toBe(false);
    expect(cache.size).toBe(2);
  });

  it('never grows past its capacity, evicting the least-recently-used key', () => {
    const cache = new LruMap<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.keys()).toEqual(['b', 'c', 'd']);
  });

  it('a hit refreshes a key, so it survives the next eviction', () => {
    const cache = new LruMap<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // 'a' is the oldest insertion, but reading it makes it the newest use —
    // 'b' should be evicted instead.
    expect(cache.get('a')).toBe(1);
    cache.set('d', 4);
    expect(cache.keys()).toEqual(['c', 'a', 'd']);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });

  it('re-setting an existing key updates it in place without growing or evicting', () => {
    const cache = new LruMap<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    // eslint-disable-next-line sonarjs/no-element-overwrite -- overwriting 'a' is the behaviour under test.
    cache.set('a', 99);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(99);
    expect(cache.get('b')).toBe(2);
  });

  it('re-setting an existing key also counts as a use', () => {
    const cache = new LruMap<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    // eslint-disable-next-line sonarjs/no-element-overwrite -- overwriting 'a' is the behaviour under test.
    cache.set('a', 11);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.keys()).toEqual(['a', 'c']);
  });

  it('holds a single entry at capacity 1', () => {
    const cache = new LruMap<string, number>(1);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size).toBe(1);
    expect(cache.keys()).toEqual(['b']);
  });

  it('clear() empties it', () => {
    const cache = new LruMap<string, number>(2);
    cache.set('a', 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('rejects a capacity that is not a positive integer', () => {
    expect(() => new LruMap<string, number>(0)).toThrow(/positive integer/);
    expect(() => new LruMap<string, number>(-1)).toThrow(/positive integer/);
    expect(() => new LruMap<string, number>(1.5)).toThrow(/positive integer/);
  });
});
