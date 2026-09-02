import { describe, expect, it } from 'vitest';
import { flattenHeaders } from './headers';

describe('flattenHeaders', () => {
  it('joins a multi-value header with a comma', () => {
    expect(flattenHeaders({ 'set-cookie': ['a=1', 'b=2'] })).toEqual({ 'set-cookie': 'a=1, b=2' });
  });

  it('drops undefined values', () => {
    expect(flattenHeaders({ 'x-a': '1', 'x-b': undefined })).toEqual({ 'x-a': '1' });
  });

  it('passes a single string value through unchanged', () => {
    expect(flattenHeaders({ 'content-type': 'text/plain' })).toEqual({ 'content-type': 'text/plain' });
  });
});
