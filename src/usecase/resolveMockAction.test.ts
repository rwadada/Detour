import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MockBodyFileReader } from './ports/mockBodyFileReader';
import { resolveMockAction } from './resolveMockAction';

describe('resolveMockAction', () => {
  it('builds the response inline (no file read) when bodyFile is not set', () => {
    const reader: MockBodyFileReader = { read: () => Buffer.from('should not be called') };
    const res = resolveMockAction({ type: 'mock', body: { a: 1 } }, '/base', reader);
    expect(res.body.toString('utf8')).toBe(JSON.stringify({ a: 1 }));
  });

  it('reads bodyFile via the injected reader, resolved against basePath', () => {
    const seen: string[] = [];
    const reader: MockBodyFileReader = {
      read: (filePath) => {
        seen.push(filePath);
        return Buffer.from('{"from":"file"}');
      },
    };
    const res = resolveMockAction({ type: 'mock', bodyFile: 'body.json' }, '/base', reader);
    expect(seen).toEqual([path.resolve('/base', 'body.json')]);
    expect(res.body.toString('utf8')).toBe('{"from":"file"}');
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
  });
});
