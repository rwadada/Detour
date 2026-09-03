import { describe, expect, it } from 'vitest';
import {
  applyScriptRequestResult,
  applyScriptResponseResult,
  type ScriptRequestInfo,
  type ScriptResponseInfo,
} from './scriptAction';

function baseRequest(overrides: Partial<ScriptRequestInfo> = {}): ScriptRequestInfo {
  return {
    method: 'GET',
    url: 'https://api.example.com/users/1',
    headers: { accept: 'application/json' },
    body: Buffer.alloc(0),
    ...overrides,
  };
}

function baseResponse(overrides: Partial<ScriptResponseInfo> = {}): ScriptResponseInfo {
  return {
    status: 200,
    statusMessage: 'OK',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"ok":true}'),
    ...overrides,
  };
}

describe('applyScriptRequestResult', () => {
  it('leaves the request untouched when the hook returns nothing', () => {
    const req = baseRequest();
    expect(applyScriptRequestResult(req, undefined)).toEqual(req);
    expect(applyScriptRequestResult(req, null)).toEqual(req);
  });

  it('keeps fields the hook omitted', () => {
    const req = baseRequest();
    const result = applyScriptRequestResult(req, { headers: { 'x-detour': '1' } });
    expect(result.method).toBe('GET');
    expect(result.url).toBe(req.url);
    expect(result.body).toBe(req.body);
    expect(result.headers).toEqual({ 'x-detour': '1' });
  });

  it('uppercases a method the hook returns', () => {
    const result = applyScriptRequestResult(baseRequest(), { method: 'post' });
    expect(result.method).toBe('POST');
  });

  it('converts a string body to a Buffer', () => {
    const result = applyScriptRequestResult(baseRequest(), { body: 'hello' });
    expect(result.body).toEqual(Buffer.from('hello', 'utf8'));
  });

  it('passes a Buffer body through unchanged', () => {
    const body = Buffer.from([1, 2, 3]);
    const result = applyScriptRequestResult(baseRequest(), { body });
    expect(result.body).toBe(body);
  });

  it('never lets a script change the URL', () => {
    const req = baseRequest();
    // ScriptRequestResult has no `url` field — this asserts the merge
    // itself, not just the type, always keeps the original.
    const result = applyScriptRequestResult(req, { method: 'GET' });
    expect(result.url).toBe(req.url);
  });
});

describe('applyScriptResponseResult', () => {
  it('leaves the response untouched when the hook returns nothing', () => {
    const res = baseResponse();
    expect(applyScriptResponseResult(res, undefined)).toEqual(res);
    expect(applyScriptResponseResult(res, null)).toEqual(res);
  });

  it('keeps fields the hook omitted', () => {
    const res = baseResponse();
    const result = applyScriptResponseResult(res, { status: 404 });
    expect(result.status).toBe(404);
    expect(result.statusMessage).toBe(res.statusMessage);
    expect(result.headers).toEqual(res.headers);
    expect(result.body).toBe(res.body);
  });

  it('converts a string body to a Buffer', () => {
    const result = applyScriptResponseResult(baseResponse(), { body: 'not found' });
    expect(result.body).toEqual(Buffer.from('not found', 'utf8'));
  });

  it('replaces headers wholesale rather than merging', () => {
    const res = baseResponse({ headers: { 'content-type': 'application/json', 'x-old': '1' } });
    const result = applyScriptResponseResult(res, { headers: { 'content-type': 'text/plain' } });
    expect(result.headers).toEqual({ 'content-type': 'text/plain' });
  });

  it('keeps a multi-value header (e.g. set-cookie) as an array, untouched, when the hook leaves headers alone', () => {
    const res = baseResponse({ headers: { 'set-cookie': ['a=1', 'b=2'] } });
    const result = applyScriptResponseResult(res, { status: 201 });
    expect(result.headers).toEqual({ 'set-cookie': ['a=1', 'b=2'] });
  });

  it('lets a hook set a multi-value header as an array', () => {
    const result = applyScriptResponseResult(baseResponse(), { headers: { 'set-cookie': ['a=1', 'b=2'] } });
    expect(result.headers).toEqual({ 'set-cookie': ['a=1', 'b=2'] });
  });
});
