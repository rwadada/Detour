import { describe, expect, it } from 'vitest';
import type { CapturedExchange } from './types';
import { ExchangeRegistry } from './exchangeRegistry';

function createDummyExchange(id: string): CapturedExchange {
  return {
    id,
    method: 'GET',
    url: 'http://example.com/',
    host: 'example.com',
    isSSL: false,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 1000,
  };
}

describe('ExchangeRegistry', () => {
  it('creates, retrieves, and finalizes an exchange context', () => {
    const registry = new ExchangeRegistry();
    const exchange = createDummyExchange('req-1');

    expect(registry.size).toBe(0);
    expect(registry.has('req-1')).toBe(false);

    const context = registry.create('req-1', exchange);
    expect(context.id).toBe('req-1');
    expect(context.exchange).toBe(exchange);
    expect(registry.size).toBe(1);
    expect(registry.has('req-1')).toBe(true);
    expect(registry.get('req-1')).toBe(context);
    expect(registry.getExchange('req-1')).toBe(exchange);

    const finalized = registry.finalize('req-1');
    expect(finalized).toBe(context);
    expect(registry.size).toBe(0);
    expect(registry.has('req-1')).toBe(false);
    expect(registry.get('req-1')).toBeUndefined();
    expect(registry.getExchange('req-1')).toBeUndefined();
  });

  it('returns undefined when finalizing an unknown id', () => {
    const registry = new ExchangeRegistry();
    expect(registry.finalize('non-existent')).toBeUndefined();
  });

  it('clears all contexts', () => {
    const registry = new ExchangeRegistry();
    registry.create('1', createDummyExchange('1'));
    registry.create('2', createDummyExchange('2'));
    expect(registry.size).toBe(2);

    registry.clear();
    expect(registry.size).toBe(0);
  });
});
