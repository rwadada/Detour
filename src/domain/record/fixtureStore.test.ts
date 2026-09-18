import { describe, expect, it } from 'vitest';
import { FixtureStore } from './fixtureStore';
import type { Fixture } from './types';

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    method: 'GET',
    path: '/orders/1',
    status: 200,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{}',
    ...overrides,
  };
}

describe('FixtureStore', () => {
  it('matches an exact method + path (including query string)', () => {
    const store = new FixtureStore([fixture({ path: '/orders/1?expand=items', responseBody: '"a"' })]);
    expect(store.findFixture('GET', '/orders/1?expand=items')).toMatchObject({ responseBody: '"a"' });
  });

  it('matches case-insensitively on method', () => {
    const store = new FixtureStore([fixture({ method: 'POST' })]);
    expect(store.findFixture('post', '/orders/1')).toBeDefined();
  });

  it('falls back to pathname-only matching when the exact query string never recurs', () => {
    const store = new FixtureStore([fixture({ path: '/orders/1?ts=111', responseBody: '"a"' })]);
    // A different (e.g. non-deterministic) query value than what was recorded.
    expect(store.findFixture('GET', '/orders/1?ts=999')).toMatchObject({ responseBody: '"a"' });
  });

  it('prefers an exact match over the pathname-only fallback when both exist', () => {
    const store = new FixtureStore([
      fixture({ path: '/orders?page=1', responseBody: '"page1"' }),
      fixture({ path: '/orders?page=2', responseBody: '"page2"' }),
    ]);
    expect(store.findFixture('GET', '/orders?page=2')).toMatchObject({ responseBody: '"page2"' });
  });

  it('returns undefined when nothing matches', () => {
    const store = new FixtureStore([fixture({ path: '/orders/1' })]);
    expect(store.findFixture('GET', '/unrelated')).toBeUndefined();
  });

  it('replays multiple recordings of the same key round-robin, in the order given', () => {
    const store = new FixtureStore([
      fixture({ path: '/poll', responseBody: '"first"' }),
      fixture({ path: '/poll', responseBody: '"second"' }),
      fixture({ path: '/poll', responseBody: '"third"' }),
    ]);
    expect(store.findFixture('GET', '/poll')).toMatchObject({ responseBody: '"first"' });
    expect(store.findFixture('GET', '/poll')).toMatchObject({ responseBody: '"second"' });
    expect(store.findFixture('GET', '/poll')).toMatchObject({ responseBody: '"third"' });
  });

  it('sticks on the last recording once exhausted rather than erroring on extra requests', () => {
    const store = new FixtureStore([
      fixture({ path: '/poll', responseBody: '"first"' }),
      fixture({ path: '/poll', responseBody: '"second"' }),
    ]);
    store.findFixture('GET', '/poll');
    store.findFixture('GET', '/poll');
    expect(store.findFixture('GET', '/poll')).toMatchObject({ responseBody: '"second"' });
    expect(store.findFixture('GET', '/poll')).toMatchObject({ responseBody: '"second"' });
  });

  it('keeps separate round-robin cursors for the exact-match and pathname-only tiers', () => {
    const store = new FixtureStore([
      fixture({ path: '/orders?page=1', responseBody: '"exact-page1"' }),
      fixture({ path: '/other', responseBody: '"other-a"' }),
      fixture({ path: '/other', responseBody: '"other-b"' }),
    ]);
    // Exhaust the exact match for /orders?page=1 (only one recording) —
    // must not somehow disturb the independent /other pathname-tier cursor.
    expect(store.findFixture('GET', '/orders?page=1')).toMatchObject({ responseBody: '"exact-page1"' });
    expect(store.findFixture('GET', '/other')).toMatchObject({ responseBody: '"other-a"' });
    expect(store.findFixture('GET', '/other')).toMatchObject({ responseBody: '"other-b"' });
  });
});
