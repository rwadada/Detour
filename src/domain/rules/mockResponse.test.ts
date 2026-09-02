import { describe, expect, it } from 'vitest';
import { buildMockResponse } from './mockResponse';

describe('buildMockResponse', () => {
  it('defaults to an empty 200 body when neither body nor bodyFile is set', () => {
    const res = buildMockResponse({ type: 'mock' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(Buffer.alloc(0));
    expect(res.headers['Content-Length']).toBe('0');
  });

  it('JSON-serializes an object body and sets Content-Type/-Length', () => {
    const res = buildMockResponse({ type: 'mock', body: { id: 1 } });
    expect(res.body.toString('utf8')).toBe(JSON.stringify({ id: 1 }));
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(res.headers['Content-Length']).toBe(String(res.body.length));
  });

  it('sends a string body verbatim, without a Content-Type', () => {
    const res = buildMockResponse({ type: 'mock', body: 'plain text' });
    expect(res.body.toString('utf8')).toBe('plain text');
    expect(res.headers['Content-Type']).toBeUndefined();
  });

  it('does not override an explicit Content-Type header', () => {
    const res = buildMockResponse({ type: 'mock', body: { id: 1 }, headers: { 'Content-Type': 'text/custom' } });
    expect(res.headers['Content-Type']).toBe('text/custom');
  });

  it('respects a custom status/statusMessage', () => {
    const res = buildMockResponse({ type: 'mock', status: 201, statusMessage: 'Created' });
    expect(res.status).toBe(201);
    expect(res.statusMessage).toBe('Created');
  });

  it('uses the resolved bodyFile bytes over an inline `body`', () => {
    const res = buildMockResponse(
      { type: 'mock', bodyFile: 'body.json', body: { from: 'inline' } },
      { bytes: Buffer.from('{"from":"file"}'), looksLikeJson: true },
    );
    expect(res.body.toString('utf8')).toBe('{"from":"file"}');
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
  });

  it('does not assume JSON for a non-.json bodyFile', () => {
    const res = buildMockResponse(
      { type: 'mock', bodyFile: 'body.txt' },
      { bytes: Buffer.from('hello'), looksLikeJson: false },
    );
    expect(res.headers['Content-Type']).toBeUndefined();
  });
});
