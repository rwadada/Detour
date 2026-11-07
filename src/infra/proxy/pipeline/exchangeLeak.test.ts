import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ExchangeRegistry } from '../../../domain/exchange/exchangeRegistry';
import type { CapturedExchange } from '../../../domain/exchange/types';
import type { ScriptResponseInfo } from '../../../domain/rules/scriptAction';
import type { Rule } from '../../../domain/rules/types';
import { BreakpointCoordinator } from '../../../usecase/breakpointCoordinator';
import { ProxyRuntimeState } from '../../../usecase/proxyRuntimeState';
import type { RuleEngine } from '../../../usecase/ruleEngine';
import { DetourEventBus } from '../../eventBus';
import type { IContext } from '../engine/types';
import { createProxyErrorHandler } from './proxyErrorHandler';
import { createRequestBreakpointHandler } from './requestBreakpoint';
import { createRequestHandler } from './requestHandler';
import { createResponseBreakpointHandler } from './responseBreakpoint';
import { createResponseHandler } from './responseHandler';
import { createScriptRequestHookHandler } from './scriptRequestHook';
import { createScriptResponseHookHandler } from './scriptResponseHook';

const noopRequestBreakpoint = (() => {}) as unknown as ReturnType<typeof createRequestBreakpointHandler>;
const noopScriptRequestHook = (() => {}) as unknown as ReturnType<typeof createScriptRequestHookHandler>;

function createFakeExchange(id: string): CapturedExchange {
  return {
    id,
    method: 'GET',
    url: 'http://example.com/test',
    host: 'example.com',
    isSSL: false,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: Date.now(),
  };
}

function createFakeContext(uuid = 'test-uuid'): {
  ctx: IContext;
  triggerResponseEnd: () => void;
} {
  const reqEmitter = new EventEmitter();
  Object.assign(reqEmitter, {
    method: 'GET',
    url: '/test',
    headers: { host: 'example.com' },
    socket: { remoteAddress: '127.0.0.1', remotePort: 12345 },
    complete: true,
    resume: () => {},
  });

  const resEmitter = new EventEmitter();
  Object.assign(resEmitter, {
    writeHead: () => {},
    end: () => {},
    destroy: () => {},
    write: () => true,
    headersSent: false,
    writableEnded: false,
  });

  const serverResEmitter = new EventEmitter();
  Object.assign(serverResEmitter, {
    statusCode: 200,
    statusMessage: 'OK',
    headers: {},
    readableEnded: true,
    resume: () => {},
  });

  let capturedResponseEndCb: ((ctx: unknown, cb: () => void) => void) | undefined;

  const ctx = {
    uuid,
    isSSL: false,
    clientToProxyRequest: reqEmitter,
    proxyToClientResponse: resEmitter,
    serverToProxyResponse: serverResEmitter,
    proxyToServerRequest: undefined,
    proxyToServerRequestOptions: { host: 'example.com', port: 80, path: '/test', headers: {} },
    responseContentPotentiallyModified: false,
    onRequestData: (_cb: unknown) => {},
    onRequestEnd: (cb: () => void) => cb(),
    onResponseData: (_cb: unknown) => {},
    onResponseEnd: (fn: (ctx: unknown, cb: () => void) => void) => {
      capturedResponseEndCb = fn;
    },
  } as unknown as IContext;

  return {
    ctx,
    triggerResponseEnd: () => {
      capturedResponseEndCb?.({}, () => {});
    },
  };
}

describe('ExchangeContext leak prevention (issue #208)', () => {
  it('cleans up context on proxy error (upstream error / client abort)', () => {
    const eventBus = new DetourEventBus();
    eventBus.on('error', () => {});
    const breakpoints = new BreakpointCoordinator();
    const exchangeRegistry = new ExchangeRegistry();

    const { ctx } = createFakeContext('err-1');
    exchangeRegistry.create('err-1', createFakeExchange('err-1'));
    expect(exchangeRegistry.size).toBe(1);

    const errorHandler = createProxyErrorHandler({ eventBus, breakpoints, exchangeRegistry });
    errorHandler(ctx, new Error('connection reset'), 'UPSTREAM_ERROR');

    expect(exchangeRegistry.size).toBe(0);
    expect(exchangeRegistry.has('err-1')).toBe(false);
  });

  it('cleans up context when request is blocked (Block Hosts forbidden)', () => {
    const eventBus = new DetourEventBus();
    const exchangeRegistry = new ExchangeRegistry();
    const runtimeState = new ProxyRuntimeState({
      blockHostsState: { hosts: ['example.com'], mode: 'forbidden' },
    });

    const handler = createRequestHandler({
      eventBus,
      runtimeState,
      clientProcessDirectory: undefined,
      exchangeRegistry,
      handleRequestBreakpoint: noopRequestBreakpoint,
      handleScriptRequestHook: noopScriptRequestHook,
    });

    const { ctx } = createFakeContext('block-1');
    handler(ctx, () => {});

    expect(exchangeRegistry.size).toBe(0);
    expect(exchangeRegistry.has('block-1')).toBe(false);
  });

  it('cleans up context when request is blocked (Block Hosts reset)', () => {
    const eventBus = new DetourEventBus();
    const exchangeRegistry = new ExchangeRegistry();
    const runtimeState = new ProxyRuntimeState({
      blockHostsState: { hosts: ['example.com'], mode: 'reset' },
    });

    const handler = createRequestHandler({
      eventBus,
      runtimeState,
      clientProcessDirectory: undefined,
      exchangeRegistry,
      handleRequestBreakpoint: noopRequestBreakpoint,
      handleScriptRequestHook: noopScriptRequestHook,
    });

    const { ctx } = createFakeContext('block-reset');
    handler(ctx, () => {});

    expect(exchangeRegistry.size).toBe(0);
  });

  it('cleans up context on mock response completion', () => {
    const eventBus = new DetourEventBus();
    const exchangeRegistry = new ExchangeRegistry();
    const mockRule: Rule = {
      name: 'Mock Rule',
      match: { url: '*' },
      action: { type: 'mock', status: 200, body: 'ok' },
    };
    const runtimeState = new ProxyRuntimeState({
      ruleEngine: {
        matchAll: () => ({ rewrites: [], terminal: mockRule }),
        resolveMockStep: () => ({ status: 200, body: 'ok' }),
        basePath: '/tmp',
        allowExternalScriptPaths: false,
      } as unknown as RuleEngine,
    });

    const handler = createRequestHandler({
      eventBus,
      runtimeState,
      clientProcessDirectory: undefined,
      exchangeRegistry,
      handleRequestBreakpoint: noopRequestBreakpoint,
      handleScriptRequestHook: noopScriptRequestHook,
    });

    const { ctx } = createFakeContext('mock-1');
    handler(ctx, () => {});

    expect(exchangeRegistry.size).toBe(0);
    expect(exchangeRegistry.has('mock-1')).toBe(false);
  });

  it('cleans up context on mock simulate close', () => {
    const eventBus = new DetourEventBus();
    const exchangeRegistry = new ExchangeRegistry();
    const mockRule: Rule = {
      name: 'Mock Close',
      match: { url: '*' },
      action: { type: 'mock', simulate: 'close' },
    };
    const runtimeState = new ProxyRuntimeState({
      ruleEngine: {
        matchAll: () => ({ rewrites: [], terminal: mockRule }),
        resolveMockStep: () => ({ simulate: 'close' }),
        basePath: '/tmp',
        allowExternalScriptPaths: false,
      } as unknown as RuleEngine,
    });

    const handler = createRequestHandler({
      eventBus,
      runtimeState,
      clientProcessDirectory: undefined,
      exchangeRegistry,
      handleRequestBreakpoint: noopRequestBreakpoint,
      handleScriptRequestHook: noopScriptRequestHook,
    });

    const { ctx } = createFakeContext('mock-close');
    handler(ctx, () => {});

    expect(exchangeRegistry.size).toBe(0);
  });

  it('cleans up context on normal response completion', () => {
    const eventBus = new DetourEventBus();
    const exchangeRegistry = new ExchangeRegistry();
    const runtimeState = new ProxyRuntimeState();

    const { ctx, triggerResponseEnd } = createFakeContext('resp-1');
    exchangeRegistry.create('resp-1', createFakeExchange('resp-1'));
    expect(exchangeRegistry.size).toBe(1);

    const responseHandler = createResponseHandler({ eventBus, runtimeState, exchangeRegistry });
    responseHandler(ctx, () => {});

    triggerResponseEnd();

    expect(exchangeRegistry.size).toBe(0);
    expect(exchangeRegistry.has('resp-1')).toBe(false);
  });

  it('cleans up context on request breakpoint abort', async () => {
    const eventBus = new DetourEventBus();
    const breakpoints = new BreakpointCoordinator();
    const exchangeRegistry = new ExchangeRegistry();

    const rule: Rule = {
      name: 'BP',
      match: { url: '*' },
      action: { type: 'breakpoint', request: true },
    };

    const handler = createRequestBreakpointHandler({ eventBus, breakpoints, exchangeRegistry });
    const { ctx } = createFakeContext('bp-abort');
    const exchange = createFakeExchange('bp-abort');
    exchangeRegistry.create('bp-abort', exchange);

    handler(ctx, rule, exchange, () => {});

    // Abort breakpoint
    breakpoints.resolve({ id: 'bp-abort', phase: 'request', action: 'abort' });

    await new Promise((r) => setTimeout(r, 10));

    expect(exchangeRegistry.size).toBe(0);
  });

  it('cleans up context on response breakpoint abort', async () => {
    const eventBus = new DetourEventBus();
    const breakpoints = new BreakpointCoordinator();
    const exchangeRegistry = new ExchangeRegistry();

    const rule: Rule = {
      name: 'Resp BP',
      match: { url: '*' },
      action: { type: 'breakpoint', response: true },
    };

    const handler = createResponseBreakpointHandler({ eventBus, breakpoints, exchangeRegistry });
    const { ctx } = createFakeContext('resp-bp-abort');
    const exchange = createFakeExchange('resp-bp-abort');
    exchangeRegistry.create('resp-bp-abort', exchange);

    handler(ctx, rule, () => {});

    // Abort breakpoint
    breakpoints.resolve({ id: 'resp-bp-abort', phase: 'response', action: 'abort' });

    await new Promise((r) => setTimeout(r, 10));

    expect(exchangeRegistry.size).toBe(0);
  });

  it('cleans up context on response breakpoint resume and finish', async () => {
    const eventBus = new DetourEventBus();
    const breakpoints = new BreakpointCoordinator();
    const exchangeRegistry = new ExchangeRegistry();

    const rule: Rule = {
      name: 'Resp BP Resume',
      match: { url: '*' },
      action: { type: 'breakpoint', response: true },
    };

    const handler = createResponseBreakpointHandler({ eventBus, breakpoints, exchangeRegistry });
    const { ctx, triggerResponseEnd } = createFakeContext('resp-bp-resume');
    const exchange = createFakeExchange('resp-bp-resume');
    exchangeRegistry.create('resp-bp-resume', exchange);

    handler(ctx, rule, () => {});

    // Resume breakpoint
    breakpoints.resolve({ id: 'resp-bp-resume', phase: 'response', action: 'resume' });

    await new Promise((r) => setTimeout(r, 10));

    triggerResponseEnd();

    expect(exchangeRegistry.size).toBe(0);
  });

  it('cleans up context on script response hook finish', async () => {
    const eventBus = new DetourEventBus();
    const exchangeRegistry = new ExchangeRegistry();

    const rule: Rule = {
      name: 'Script',
      match: { url: '*' },
      action: { type: 'script', path: 'test.js' },
    };
    const module = {
      beforeResponse: (_req: unknown, res: ScriptResponseInfo) => Promise.resolve(res),
    };

    const handler = createScriptResponseHookHandler({ eventBus, exchangeRegistry });
    const { ctx, triggerResponseEnd } = createFakeContext('script-resp');
    const exchange = createFakeExchange('script-resp');
    exchangeRegistry.create('script-resp', exchange);

    handler(ctx, rule, module, () => {});

    await new Promise((r) => setTimeout(r, 10));

    triggerResponseEnd();

    expect(exchangeRegistry.size).toBe(0);
  });
});
