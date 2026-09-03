import { describe, expect, it } from 'vitest';
import type { ScriptModule, ScriptRequestInfo, ScriptResponseInfo } from '../domain/rules/scriptAction';
import { runBeforeRequest, runBeforeResponse } from './runScriptHooks';

function baseRequest(overrides: Partial<ScriptRequestInfo> = {}): ScriptRequestInfo {
  return { method: 'GET', url: 'https://api.example.com/x', headers: {}, body: Buffer.alloc(0), ...overrides };
}

function baseResponse(overrides: Partial<ScriptResponseInfo> = {}): ScriptResponseInfo {
  return { status: 200, headers: {}, body: Buffer.alloc(0), ...overrides };
}

describe('runBeforeRequest', () => {
  it('returns the request unchanged when the module has no beforeRequest hook', async () => {
    const req = baseRequest();
    const result = await runBeforeRequest({}, req);
    expect(result).toEqual(req);
  });

  it("applies the hook's partial result", async () => {
    const module: ScriptModule = { beforeRequest: () => ({ headers: { 'x-detour': '1' } }) };
    const result = await runBeforeRequest(module, baseRequest());
    expect(result.headers).toEqual({ 'x-detour': '1' });
  });

  it('awaits an async hook', async () => {
    const module: ScriptModule = {
      beforeRequest: async (req) => {
        await Promise.resolve();
        return { body: `${req.body.toString()}!` };
      },
    };
    const result = await runBeforeRequest(module, baseRequest({ body: Buffer.from('hi') }));
    expect(result.body.toString()).toBe('hi!');
  });

  it("gives the hook a fresh headers object rather than the caller's own", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const module: ScriptModule = {
      beforeRequest: (req) => {
        seenHeaders = req.headers;
        req.headers['mutated'] = 'yes'; // Mutating the hook's own copy — proves it doesn't leak back to the caller.
        return undefined;
      },
    };
    const original = { accept: 'json' };
    await runBeforeRequest(module, baseRequest({ headers: original }));
    expect(seenHeaders).not.toBe(original);
    expect(original).toEqual({ accept: 'json' });
  });

  it("propagates a hook's thrown error to the caller", async () => {
    const module: ScriptModule = {
      beforeRequest: () => {
        throw new Error('boom');
      },
    };
    await expect(runBeforeRequest(module, baseRequest())).rejects.toThrow('boom');
  });
});

describe('runBeforeResponse', () => {
  it('returns the response unchanged when the module has no beforeResponse hook', async () => {
    const res = baseResponse();
    const result = await runBeforeResponse({}, baseRequest(), res);
    expect(result).toEqual(res);
  });

  it("applies the hook's partial result, given both req and res", async () => {
    const module: ScriptModule = {
      beforeResponse: (req, res) => ({ status: 200, body: `${req.method} ${res.body.toString()}` }),
    };
    const result = await runBeforeResponse(
      module,
      baseRequest({ method: 'POST' }),
      baseResponse({ body: Buffer.from('ok') }),
    );
    expect(result.body.toString()).toBe('POST ok');
  });

  it('propagates a rejected hook promise to the caller', async () => {
    const module: ScriptModule = { beforeResponse: () => Promise.reject(new Error('nope')) };
    await expect(runBeforeResponse(module, baseRequest(), baseResponse())).rejects.toThrow('nope');
  });
});
