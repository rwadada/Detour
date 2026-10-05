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

  it('replayEdited() sends the overrides along with the exchange', () => {
    const { connection, sent } = fakeDashboardConnection();
    const store = createReplayStore(connection);

    store.getState().replayEdited(exchange({ id: 'a' }), { method: 'PUT', url: 'https://example.com/x' });

    expect(sent).toEqual([
      {
        type: 'replay',
        exchange: exchange({ id: 'a' }),
        overrides: { method: 'PUT', url: 'https://example.com/x' },
      },
    ]);
  });

  describe('failure reporting', () => {
    const errorMessage = (errorKind: string, message: string) =>
      ({ type: 'error', event: { errorKind, message } }) as const;

    it('starts with no failure', () => {
      expect(createReplayStore(fakeDashboardConnection().connection).getState().failure).toBeNull();
    });

    it('records a refused or failed replay, with a rising seq so a new one is distinguishable', () => {
      const fake = fakeDashboardConnection();
      const store = createReplayStore(fake.connection);

      fake.emit(errorMessage('REPLAY_REJECTED', 'Refused to replay to http://localhost:4040/'));
      expect(store.getState().failure).toEqual({ seq: 1, message: 'Refused to replay to http://localhost:4040/' });

      fake.emit(errorMessage('REPLAY_ERROR', 'boom'));
      expect(store.getState().failure).toEqual({ seq: 2, message: 'boom' });
    });

    it('ignores unrelated errors', () => {
      const fake = fakeDashboardConnection();
      const store = createReplayStore(fake.connection);
      fake.emit(errorMessage('PROXY_TO_SERVER_ERROR', 'ECONNRESET'));
      expect(store.getState().failure).toBeNull();
    });
  });
});
