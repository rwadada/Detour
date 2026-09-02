import { describe, expect, it } from 'vitest';
import { applyHeaderRewrite } from './headerRewrite';

describe('applyHeaderRewrite', () => {
  it('sets and removes headers, remove running before set', () => {
    const headers: Record<string, string> = { Authorization: 'secret', 'X-Keep': '1' };
    applyHeaderRewrite(headers, { set: { 'X-Detour': '1' }, remove: ['Authorization'] });
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['X-Keep']).toBe('1');
    expect(headers['X-Detour']).toBe('1');
  });

  it('removes a header case-insensitively', () => {
    const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
    applyHeaderRewrite(headers, { remove: ['content-type'] });
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('is a no-op when no rewrite is given', () => {
    const headers: Record<string, string> = { a: '1' };
    applyHeaderRewrite(headers, undefined);
    expect(headers).toEqual({ a: '1' });
  });
});
