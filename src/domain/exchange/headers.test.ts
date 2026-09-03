import { describe, expect, it } from 'vitest';
import { compactHeaders, findHeader, flattenHeaders } from './headers';

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

describe('compactHeaders', () => {
  it('keeps a multi-value header as an array instead of joining it', () => {
    expect(compactHeaders({ 'set-cookie': ['a=1', 'b=2'] })).toEqual({ 'set-cookie': ['a=1', 'b=2'] });
  });

  it('drops undefined values', () => {
    expect(compactHeaders({ 'x-a': '1', 'x-b': undefined })).toEqual({ 'x-a': '1' });
  });

  it('passes a single string value through unchanged', () => {
    expect(compactHeaders({ 'content-type': 'text/plain' })).toEqual({ 'content-type': 'text/plain' });
  });
});

describe('findHeader', () => {
  it('finds an already-lowercased header (the common case, straight off the wire)', () => {
    expect(findHeader({ 'content-type': 'application/grpc' }, 'content-type')).toBe('application/grpc');
  });

  it('finds a header regardless of its stored casing', () => {
    expect(findHeader({ 'Content-Type': 'application/grpc' }, 'content-type')).toBe('application/grpc');
    expect(findHeader({ 'CONTENT-TYPE': 'application/grpc' }, 'content-type')).toBe('application/grpc');
  });

  it('matches regardless of the casing the caller searches with', () => {
    expect(findHeader({ 'content-type': 'application/grpc' }, 'Content-Type')).toBe('application/grpc');
  });

  it('returns undefined when the header is absent', () => {
    expect(findHeader({ accept: '*/*' }, 'content-type')).toBeUndefined();
  });

  it('returns a multi-value header array as-is', () => {
    expect(findHeader({ 'Set-Cookie': ['a=1', 'b=2'] }, 'set-cookie')).toEqual(['a=1', 'b=2']);
  });
});
