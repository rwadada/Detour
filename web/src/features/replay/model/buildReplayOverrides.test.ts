import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from '@/shared/api';
import { buildReplayOverrides, draftFromExchange } from './buildReplayOverrides';

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'x1',
    method: 'POST',
    url: 'https://api.example.com/widgets',
    host: 'api.example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: { 'content-type': 'application/json', authorization: 'Bearer abc' },
    requestBodySize: 12,
    requestBody: b64('{"name":"x"}'),
    responseBodySize: 0,
    startedAt: 0,
    ...overrides,
  };
}

describe('draftFromExchange', () => {
  it('starts the form from the captured request', () => {
    const { draft, bodyEditable } = draftFromExchange(exchange());
    expect(draft.method).toBe('POST');
    expect(draft.url).toBe('https://api.example.com/widgets');
    expect(draft.headersText).toBe('authorization: Bearer abc\ncontent-type: application/json');
    expect(draft.bodyText).toBe('{"name":"x"}');
    expect(bodyEditable).toBe(true);
  });

  it('flags a binary or truncated body as not editable', () => {
    expect(draftFromExchange(exchange({ requestBody: btoa('\xff\xfe\x00') })).bodyEditable).toBe(false);
    expect(draftFromExchange(exchange({ requestBodyTruncated: true })).bodyEditable).toBe(false);
  });

  it('treats a request with no body as an editable empty body', () => {
    const { draft, bodyEditable } = draftFromExchange(exchange({ requestBody: undefined }));
    expect(draft.bodyText).toBe('');
    expect(bodyEditable).toBe(true);
  });
});

describe('buildReplayOverrides', () => {
  it('is empty when nothing was edited, so the server keeps the captured values', () => {
    const e = exchange();
    expect(buildReplayOverrides(e, draftFromExchange(e).draft)).toEqual({});
  });

  it('includes only the fields that changed', () => {
    const e = exchange();
    const { draft } = draftFromExchange(e);
    expect(buildReplayOverrides(e, { ...draft, method: 'PUT' })).toEqual({ method: 'PUT' });
    expect(buildReplayOverrides(e, { ...draft, url: 'https://api.example.com/other' })).toEqual({
      url: 'https://api.example.com/other',
    });
  });

  it('sends the whole edited header set, e.g. with one header removed', () => {
    const e = exchange();
    const { draft } = draftFromExchange(e);
    expect(buildReplayOverrides(e, { ...draft, headersText: 'content-type: application/json' }).headers).toEqual({
      'content-type': 'application/json',
    });
  });

  it('sends an edited body as base64, UTF-8 safe', () => {
    const e = exchange();
    const { draft } = draftFromExchange(e);
    const result = buildReplayOverrides(e, { ...draft, bodyText: '{"name":"日本語"}' });
    expect(result.body).toBe(b64('{"name":"日本語"}'));
  });

  it('can empty the body', () => {
    const e = exchange();
    expect(buildReplayOverrides(e, { ...draftFromExchange(e).draft, bodyText: '' }).body).toBe('');
  });

  it('never overrides a body that is not editable', () => {
    const e = exchange({ requestBodyTruncated: true });
    expect(buildReplayOverrides(e, { ...draftFromExchange(e).draft, bodyText: 'changed' }).body).toBeUndefined();
  });

  it('ignores a blank method or URL rather than sending an empty one', () => {
    const e = exchange();
    const { draft } = draftFromExchange(e);
    expect(buildReplayOverrides(e, { ...draft, method: '  ', url: '' })).toEqual({});
  });
});
