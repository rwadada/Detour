import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetScriptModuleCacheForTests } from '../fs/scriptModuleLoader';
import {
  applyRequestRewrite,
  applyResponseHeaderRewrite,
  applyRouteAction,
  installResponseBodyRewrite,
  loadScriptModule,
  resolveMockResponse,
  sendMockResponse,
  sendMockSimulate,
} from './actionsRuntime';
import type { IContext, OnRequestDataParams, OnRequestParams } from './engine/types';

describe('resolveMockResponse', () => {
  it('defaults to an empty 200 body when neither body nor bodyFile is set', () => {
    const res = resolveMockResponse({ type: 'mock' }, '/tmp');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(Buffer.alloc(0));
    expect(res.headers['Content-Length']).toBe('0');
  });

  it('JSON-serializes an object body and sets Content-Type/-Length', () => {
    const res = resolveMockResponse({ type: 'mock', body: { id: 1 } }, '/tmp');
    expect(res.body.toString('utf8')).toBe(JSON.stringify({ id: 1 }));
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(res.headers['Content-Length']).toBe(String(res.body.length));
  });

  it('sends a string body verbatim, without a Content-Type', () => {
    const res = resolveMockResponse({ type: 'mock', body: 'plain text' }, '/tmp');
    expect(res.body.toString('utf8')).toBe('plain text');
    expect(res.headers['Content-Type']).toBeUndefined();
  });

  it('does not override an explicit Content-Type header', () => {
    const res = resolveMockResponse(
      { type: 'mock', body: { id: 1 }, headers: { 'Content-Type': 'text/custom' } },
      '/tmp',
    );
    expect(res.headers['Content-Type']).toBe('text/custom');
  });

  it('respects a custom status/statusMessage', () => {
    const res = resolveMockResponse({ type: 'mock', status: 201, statusMessage: 'Created' }, '/tmp');
    expect(res.status).toBe(201);
    expect(res.statusMessage).toBe('Created');
  });

  it('does not override an explicit Content-Length header', () => {
    const res = resolveMockResponse({ type: 'mock', body: 'hi', headers: { 'Content-Length': '999' } }, '/tmp');
    expect(res.headers['Content-Length']).toBe('999');
  });

  describe('bodyFile', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-actions-test-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reads the file, resolved relative to basePath, and wins over `body`', () => {
      fs.writeFileSync(path.join(dir, 'body.json'), '{"from":"file"}');
      const res = resolveMockResponse({ type: 'mock', bodyFile: 'body.json', body: { from: 'inline' } }, dir);
      expect(res.body.toString('utf8')).toBe('{"from":"file"}');
      expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
    });

    it('does not assume JSON for a non-.json file extension', () => {
      fs.writeFileSync(path.join(dir, 'body.txt'), 'hello');
      const res = resolveMockResponse({ type: 'mock', bodyFile: 'body.txt' }, dir);
      expect(res.headers['Content-Type']).toBeUndefined();
    });

    describe('path traversal (issue #98)', () => {
      it('rejects a bodyFile that resolves outside basePath', () => {
        expect(() => resolveMockResponse({ type: 'mock', bodyFile: '../outside.json' }, dir)).toThrow(
          /resolves outside/,
        );
      });

      it('rejects an absolute bodyFile path', () => {
        const outsideFile = path.join(os.tmpdir(), 'detour-outside-body.json');
        fs.writeFileSync(outsideFile, '{"secret":true}');
        try {
          expect(() => resolveMockResponse({ type: 'mock', bodyFile: outsideFile }, dir)).toThrow(/resolves outside/);
        } finally {
          fs.rmSync(outsideFile, { force: true });
        }
      });

      it('allows an absolute bodyFile path when allowExternalPaths is set', () => {
        const outsideFile = path.join(os.tmpdir(), 'detour-outside-body-allowed.json');
        fs.writeFileSync(outsideFile, '{"secret":true}');
        try {
          const res = resolveMockResponse({ type: 'mock', bodyFile: outsideFile }, dir, true);
          expect(res.body.toString('utf8')).toBe('{"secret":true}');
        } finally {
          fs.rmSync(outsideFile, { force: true });
        }
      });
    });
  });
});

describe('loadScriptModule', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-script-action-test-'));
    __resetScriptModuleCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves `path` relative to basePath and loads the module', () => {
    fs.writeFileSync(path.join(dir, 'rules.script.js'), 'module.exports = { beforeRequest() {} };');
    const module = loadScriptModule({ type: 'script', path: './rules.script.js' }, dir);
    expect(typeof module.beforeRequest).toBe('function');
  });

  it('throws a descriptive error for a missing script file', () => {
    expect(() => loadScriptModule({ type: 'script', path: './nope.js' }, dir)).toThrow();
  });

  describe('path traversal (issue #98)', () => {
    it('rejects a script path that resolves outside basePath', () => {
      expect(() => loadScriptModule({ type: 'script', path: '../outside.js' }, dir)).toThrow(/resolves outside/);
    });

    it('rejects an absolute script path', () => {
      const outsideFile = path.join(os.tmpdir(), 'detour-outside-script.js');
      fs.writeFileSync(outsideFile, 'module.exports = { beforeRequest() {} };');
      try {
        expect(() => loadScriptModule({ type: 'script', path: outsideFile }, dir)).toThrow(/resolves outside/);
      } finally {
        fs.rmSync(outsideFile, { force: true });
      }
    });

    it('allows an absolute script path when allowExternalPaths is set', () => {
      const outsideFile = path.join(os.tmpdir(), 'detour-outside-script-allowed.js');
      fs.writeFileSync(outsideFile, 'module.exports = { beforeRequest() {} };');
      try {
        const module = loadScriptModule({ type: 'script', path: outsideFile }, dir, true);
        expect(typeof module.beforeRequest).toBe('function');
      } finally {
        fs.rmSync(outsideFile, { force: true });
      }
    });
  });
});

/** Builds just enough of an `IContext` for the action helpers under test, cast to the real type. */
function fakeContext(overrides: Record<string, unknown>): IContext {
  return overrides as unknown as IContext;
}

describe('applyRouteAction', () => {
  it('redirects host/port while preserving the Host header by default', () => {
    const opts = { host: 'api.example.com', port: 443, headers: {} as Record<string, string> };
    const ctx = fakeContext({ proxyToServerRequestOptions: opts, isSSL: true });
    applyRouteAction(ctx, { type: 'route', host: 'staging.example.com', port: 8443 });
    expect(opts.host).toBe('staging.example.com');
    expect(opts.port).toBe(8443);
    expect(opts.headers['host']).toBeUndefined();
  });

  it('rewrites the Host header when preserveHostHeader is false', () => {
    const opts = { host: 'api.example.com', port: 443, headers: {} as Record<string, string> };
    const ctx = fakeContext({ proxyToServerRequestOptions: opts, isSSL: true });
    applyRouteAction(ctx, { type: 'route', host: 'staging.example.com', preserveHostHeader: false });
    // No explicit `port` in the action: falls back to the original port, and
    // since it equals the default HTTPS port, no `:port` suffix is added.
    expect(opts.headers['host']).toBe('staging.example.com');
  });

  it('appends a non-default port to the rewritten Host header', () => {
    const opts = { host: 'api.example.com', port: 80, headers: {} as Record<string, string> };
    const ctx = fakeContext({ proxyToServerRequestOptions: opts, isSSL: false });
    applyRouteAction(ctx, { type: 'route', host: 'staging.example.com', port: 8080, preserveHostHeader: false });
    expect(opts.headers['host']).toBe('staging.example.com:8080');
  });
});

describe('applyRequestRewrite', () => {
  it('sets and removes query parameters, remove running before set', () => {
    const opts = { path: '/users?token=secret&x=1', headers: {} as Record<string, string> };
    const ctx = fakeContext({ proxyToServerRequestOptions: opts });
    applyRequestRewrite(ctx, { query: { set: { debug: '1' }, remove: ['token'] } });
    const url = new URL(opts.path, 'https://x');
    expect(url.searchParams.get('token')).toBeNull();
    expect(url.searchParams.get('x')).toBe('1');
    expect(url.searchParams.get('debug')).toBe('1');
  });

  it('sets and removes headers, remove running before set', () => {
    const opts = { path: '/x', headers: { Authorization: 'secret', 'X-Keep': '1' } as Record<string, string> };
    const ctx = fakeContext({ proxyToServerRequestOptions: opts });
    applyRequestRewrite(ctx, { headers: { set: { 'X-Detour': '1' }, remove: ['Authorization'] } });
    expect(opts.headers['Authorization']).toBeUndefined();
    expect(opts.headers['X-Keep']).toBe('1');
    expect(opts.headers['X-Detour']).toBe('1');
  });

  it('drops a differently-cased Content-Length re-added by rewrite.headers.set (issue #93)', () => {
    // rewrite.headers.set runs before the content-length cleanup, and can
    // spell the header with any casing the rules.json author chose — a
    // case-sensitive delete would miss it, leaving a stale length that
    // desyncs from the rewritten body an HTTP/2 client would then reject.
    const { ctx, opts } = fakeRequestBodyContext();
    opts.headers['Content-Length'] = '999';
    applyRequestRewrite(ctx, { headers: { set: { 'Content-Length': '999' } }, body: { set: { a: 1 } } });
    expect(opts.headers['content-length']).toBeUndefined();
    expect(opts.headers['Content-Length']).toBeUndefined();
  });
});

describe('applyResponseHeaderRewrite', () => {
  it('rewrites the response status and headers', () => {
    const res = { statusCode: 200, headers: { 'cache-control': 'no-store' } as Record<string, string> };
    const ctx = fakeContext({ serverToProxyResponse: res });
    applyResponseHeaderRewrite(ctx, { status: 201, headers: { set: { 'X-Detour': '1' }, remove: ['cache-control'] } });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBeUndefined();
    expect(res.headers['X-Detour']).toBe('1');
  });

  it('leaves the status untouched when not specified', () => {
    const res = { statusCode: 200, headers: {} as Record<string, string> };
    const ctx = fakeContext({ serverToProxyResponse: res });
    applyResponseHeaderRewrite(ctx, { headers: { set: { 'X-Detour': '1' } } });
    expect(res.statusCode).toBe(200);
  });

  it('drops a differently-cased Content-Length re-added by rewrite.headers.set (issue #93)', () => {
    const res = { statusCode: 200, headers: { 'content-length': '14' } as Record<string, string> };
    const ctx = fakeContext({ serverToProxyResponse: res });
    applyResponseHeaderRewrite(ctx, { headers: { set: { 'Content-Length': '999' } }, body: { set: { a: 1 } } });
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers['Content-Length']).toBeUndefined();
  });
});

describe('applyRequestRewrite: query edge case', () => {
  it('adds a query string to a path that had none', () => {
    const opts = { path: '/x', headers: {} as Record<string, string> };
    const ctx = fakeContext({ proxyToServerRequestOptions: opts });
    applyRequestRewrite(ctx, { query: { set: { debug: '1' } } });
    expect(opts.path).toBe('/x?debug=1');
  });

  it('leaves the path bare when the rewritten query string ends up empty', () => {
    const opts = { path: '/x?token=secret', headers: {} as Record<string, string> };
    const ctx = fakeContext({ proxyToServerRequestOptions: opts });
    applyRequestRewrite(ctx, { query: { remove: ['token'] } });
    expect(opts.path).toBe('/x');
  });
});

/** Builds a fake IContext that captures what a body-rewrite installer writes, by manually driving the onRequestData/onRequestEnd (or onResponseData/onResponseEnd) callbacks it registers — mirroring how ProxyEngine's real pipeline would call them. */
function fakeRequestBodyContext() {
  const written: Buffer[] = [];
  let dataHandler: OnRequestDataParams | undefined;
  let endHandler: OnRequestParams | undefined;
  const opts = { path: '/x', headers: { 'content-length': '5' } as Record<string, string> };
  const ctx = fakeContext({
    proxyToServerRequestOptions: opts,
    proxyToServerRequest: { write: (chunk: Buffer) => written.push(chunk) },
    onRequestData(fn: OnRequestDataParams) {
      dataHandler = fn;
      return ctx;
    },
    onRequestEnd(fn: OnRequestParams) {
      endHandler = fn;
      return ctx;
    },
  });
  return {
    ctx,
    opts,
    written,
    /** Feeds one chunk through, then signals end — the whole body in a single chunk is enough to exercise these installers, which buffer everything before acting. */
    deliver(body: string) {
      dataHandler?.(ctx, Buffer.from(body, 'utf8'), () => {});
      let cbCalled = false;
      endHandler?.(ctx, () => {
        cbCalled = true;
      });
      return cbCalled;
    },
  };
}

describe('applyRequestRewrite: body', () => {
  it('replaces the body wholesale with `set`, dropping Content-Length', () => {
    const { ctx, opts, written, deliver } = fakeRequestBodyContext();
    applyRequestRewrite(ctx, { body: { set: { replaced: true } } });
    expect(opts.headers['content-length']).toBeUndefined();
    const cbCalled = deliver('{"original":true}');
    expect(cbCalled).toBe(true);
    expect(Buffer.concat(written).toString('utf8')).toBe(JSON.stringify({ replaced: true }));
  });

  it('runs sequential literal and regex `replace` steps in order', () => {
    const { written, deliver, ctx } = fakeRequestBodyContext();
    applyRequestRewrite(ctx, {
      body: {
        replace: [
          { find: 'foo', replacement: 'bar' },
          { find: 'ba(r)', replacement: 'BA$1', regex: true },
        ],
      },
    });
    deliver('foo-baz');
    expect(Buffer.concat(written).toString('utf8')).toBe('BAr-baz');
  });

  it('applies a JSON Merge Patch with `merge`, deleting keys set to null', () => {
    const { written, deliver, ctx } = fakeRequestBodyContext();
    applyRequestRewrite(ctx, { body: { merge: { added: 1, removeMe: null } } });
    deliver('{"removeMe":"x","kept":"y"}');
    expect(JSON.parse(Buffer.concat(written).toString('utf8'))).toEqual({ added: 1, kept: 'y' });
  });

  it('merges onto an empty object when the original body is not valid JSON', () => {
    const { written, deliver, ctx } = fakeRequestBodyContext();
    applyRequestRewrite(ctx, { body: { merge: { a: 1 } } });
    deliver('not json');
    expect(JSON.parse(Buffer.concat(written).toString('utf8'))).toEqual({ a: 1 });
  });

  it('does not write anything when the rewritten body is empty', () => {
    const { written, deliver, ctx } = fakeRequestBodyContext();
    applyRequestRewrite(ctx, { body: { set: '' } });
    deliver('original');
    expect(written).toHaveLength(0);
  });
});

describe('installResponseBodyRewrite', () => {
  function fakeResponseBodyContext() {
    const written: Buffer[] = [];
    let dataHandler: OnRequestDataParams | undefined;
    let endHandler: OnRequestParams | undefined;
    const ctx = fakeContext({
      proxyToClientResponse: { write: (chunk: Buffer) => written.push(chunk) },
      onResponseData(fn: OnRequestDataParams) {
        dataHandler = fn;
        return ctx;
      },
      onResponseEnd(fn: OnRequestParams) {
        endHandler = fn;
        return ctx;
      },
    });
    return {
      ctx,
      written,
      deliver(body: string) {
        dataHandler?.(ctx, Buffer.from(body, 'utf8'), () => {});
        endHandler?.(ctx, () => {});
      },
    };
  }

  it('rewrites the response body and reports the final size', () => {
    const { ctx, written, deliver } = fakeResponseBodyContext();
    let finalSize: number | undefined;
    installResponseBodyRewrite(ctx, { merge: { ok: true } }, (size) => {
      finalSize = size;
    });
    deliver('{"a":1}');
    const result = Buffer.concat(written).toString('utf8');
    expect(JSON.parse(result)).toEqual({ a: 1, ok: true });
    expect(finalSize).toBe(Buffer.byteLength(result));
  });

  it('works without an onFinalSize callback', () => {
    const { ctx, written, deliver } = fakeResponseBodyContext();
    installResponseBodyRewrite(ctx, { set: 'replaced' });
    deliver('original');
    expect(Buffer.concat(written).toString('utf8')).toBe('replaced');
  });
});

describe('sendMockResponse', () => {
  function fakeMockContext() {
    const calls: { writeHead?: unknown[]; end?: unknown[]; resumed?: boolean } = {};
    const ctx = fakeContext({
      clientToProxyRequest: {
        resume: () => {
          calls.resumed = true;
        },
      },
      proxyToClientResponse: {
        writeHead: (...args: unknown[]) => {
          calls.writeHead = args;
        },
        end: (...args: unknown[]) => {
          calls.end = args;
        },
      },
    });
    return { ctx, calls };
  }

  it('drains the client request and writes status/headers/body', () => {
    const { ctx, calls } = fakeMockContext();
    sendMockResponse(ctx, { status: 200, headers: { 'Content-Type': 'text/plain' }, body: Buffer.from('hi') });
    expect(calls.resumed).toBe(true);
    expect(calls.writeHead).toEqual([200, { 'Content-Type': 'text/plain' }]);
    expect(calls.end).toEqual([Buffer.from('hi')]);
  });

  it('includes statusMessage in writeHead when set', () => {
    const { ctx, calls } = fakeMockContext();
    sendMockResponse(ctx, { status: 404, statusMessage: 'Not Found', headers: {}, body: Buffer.alloc(0) });
    expect(calls.writeHead).toEqual([404, 'Not Found', {}]);
  });

  it('omits statusMessage for an HTTP/2 client, since Http2ServerResponse.writeHead has no reason-phrase overload', () => {
    const { ctx, calls } = fakeMockContext();
    (ctx.clientToProxyRequest as { httpVersionMajor?: number }).httpVersionMajor = 2;
    sendMockResponse(ctx, { status: 404, statusMessage: 'Not Found', headers: {}, body: Buffer.alloc(0) });
    expect(calls.writeHead).toEqual([404, {}]);
  });
});

describe('sendMockSimulate', () => {
  function fakeSimulateContext() {
    const calls: { resumed?: boolean; destroyed?: boolean } = {};
    const ctx = fakeContext({
      clientToProxyRequest: {
        resume: () => {
          calls.resumed = true;
        },
      },
      proxyToClientResponse: {
        destroy: () => {
          calls.destroyed = true;
        },
      },
    });
    return { ctx, calls };
  }

  it('destroys the client connection for `close`', () => {
    const { ctx, calls } = fakeSimulateContext();
    sendMockSimulate(ctx, 'close');
    expect(calls.resumed).toBe(true);
    expect(calls.destroyed).toBe(true);
  });

  it('leaves the connection open for `timeout`', () => {
    const { ctx, calls } = fakeSimulateContext();
    sendMockSimulate(ctx, 'timeout');
    expect(calls.resumed).toBe(true);
    expect(calls.destroyed).toBeUndefined();
  });
});
