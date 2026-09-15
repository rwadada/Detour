import { describe, expect, it } from 'vitest';
import { applyPathRewrite } from './pathRewrite';

describe('applyPathRewrite', () => {
  it('replaces the whole pathname with set, leaving the query string alone', () => {
    const opts = { path: '/users/1?x=2' };
    applyPathRewrite(opts, { set: '/people/1' });
    expect(opts.path).toBe('/people/1?x=2');
  });

  it('applies sequential literal find/replace passes to the pathname only', () => {
    const opts = { path: '/v1/users/1?token=v1secret' };
    applyPathRewrite(opts, { replace: [{ find: '/v1/', replacement: '/v2/' }] });
    expect(opts.path).toBe('/v2/users/1?token=v1secret');
  });

  it('rewrites a path parameter with a regex capture group', () => {
    const opts = { path: '/users/1?x=2' };
    applyPathRewrite(opts, { replace: [{ find: '/users/(\\d+)', replacement: '/people/$1', regex: true }] });
    expect(opts.path).toBe('/people/1?x=2');
  });

  it('set wins over replace when both are given', () => {
    const opts = { path: '/users/1' };
    applyPathRewrite(opts, { set: '/override', replace: [{ find: '/users/1', replacement: '/ignored' }] });
    expect(opts.path).toBe('/override');
  });

  it('leaves a path with no query string alone', () => {
    const opts = { path: '/users/1' };
    applyPathRewrite(opts, { set: '/people/1' });
    expect(opts.path).toBe('/people/1');
  });

  it('is a no-op when no rewrite is given', () => {
    const opts = { path: '/x?a=1' };
    applyPathRewrite(opts, undefined);
    expect(opts.path).toBe('/x?a=1');
  });
});
