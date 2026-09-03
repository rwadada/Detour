import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection, type CapturedExchange } from '@/shared/api';
import { createReplayStore } from './createReplayStore';

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'x1',
    method: 'GET',
    url: 'https://example.com/',
    host: 'example.com',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 0,
    ...overrides,
  };
}

describe('createReplayStore', () => {
  it('replay() sends a `replay` command with the given exchange', () => {
    const { connection, sent } = fakeDashboardConnection();
    const store = createReplayStore(connection);

    store.getState().replay(exchange({ id: 'a' }));

    expect(sent).toEqual([{ type: 'replay', exchange: exchange({ id: 'a' }) }]);
  });
});
