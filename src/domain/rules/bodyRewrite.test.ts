import { describe, expect, it } from 'vitest';
import { applyBodyRewrite } from './bodyRewrite';

describe('applyBodyRewrite', () => {
  it('replaces the body wholesale with `set`', () => {
    const result = applyBodyRewrite(Buffer.from('{"original":true}'), { set: { replaced: true } });
    expect(result.toString('utf8')).toBe(JSON.stringify({ replaced: true }));
  });

  it('runs sequential literal and regex `replace` steps in order', () => {
    const result = applyBodyRewrite(Buffer.from('foo-baz'), {
      replace: [
        { find: 'foo', replacement: 'bar' },
        { find: 'ba(r)', replacement: 'BA$1', regex: true },
      ],
    });
    expect(result.toString('utf8')).toBe('BAr-baz');
  });

  it('applies a JSON Merge Patch with `merge`, deleting keys set to null', () => {
    const result = applyBodyRewrite(Buffer.from('{"removeMe":"x","kept":"y"}'), {
      merge: { added: 1, removeMe: null },
    });
    expect(JSON.parse(result.toString('utf8'))).toEqual({ added: 1, kept: 'y' });
  });

  it('merges onto an empty object when the original body is not valid JSON', () => {
    const result = applyBodyRewrite(Buffer.from('not json'), { merge: { a: 1 } });
    expect(JSON.parse(result.toString('utf8'))).toEqual({ a: 1 });
  });

  it('returns an empty buffer when `set` is an empty string', () => {
    const result = applyBodyRewrite(Buffer.from('original'), { set: '' });
    expect(result).toHaveLength(0);
  });
});
