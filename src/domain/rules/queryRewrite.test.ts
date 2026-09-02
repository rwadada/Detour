import { describe, expect, it } from 'vitest';
import { applyQueryRewrite } from './queryRewrite';

describe('applyQueryRewrite', () => {
  it('sets and removes query parameters, remove running before set', () => {
    const opts = { path: '/users?token=secret&x=1' };
    applyQueryRewrite(opts, { set: { debug: '1' }, remove: ['token'] });
    const url = new URL(opts.path, 'https://x');
    expect(url.searchParams.get('token')).toBeNull();
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.searchParams.get('debug')).toBe('1');
  });

  it('adds a query string to a path that had none', () => {
    const opts = { path: '/x' };
    applyQueryRewrite(opts, { set: { debug: '1' } });
    expect(opts.path).toBe('/x?debug=1');
  });

  it('leaves the path bare when the rewritten query string ends up empty', () => {
    const opts = { path: '/x?token=secret' };
    applyQueryRewrite(opts, { remove: ['token'] });
    expect(opts.path).toBe('/x');
  });

  it('is a no-op when no rewrite is given', () => {
    const opts = { path: '/x?a=1' };
    applyQueryRewrite(opts, undefined);
    expect(opts.path).toBe('/x?a=1');
  });
});
