import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection, type CapturedExchange } from '@/shared/api';
import { createBreakpointResumeStore } from './createBreakpointResumeStore';

function exchange(overrides: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    id: 'a',
    method: 'GET',
    url: 'https://x/',
    host: 'x',
    isSSL: true,
    protocol: 'HTTP/1.1',
    requestHeaders: {},
    requestBodySize: 0,
    responseBodySize: 0,
    startedAt: 0,
    ...overrides,
  };
}

const payload = { phase: 'request' as const, id: 'a', method: 'GET', path: '/', headers: {}, bodyTruncated: false };

describe('createBreakpointResumeStore', () => {
  it('tracks an exchange paused by a breakpoint message', () => {
    const fake = fakeDashboardConnection();
    const store = createBreakpointResumeStore(fake.connection);
    fake.emit({ type: 'breakpoint', exchange: exchange(), payload });
    expect(store.getState().pausedBreakpoints['a']).toEqual(payload);
  });

  it('clears a paused exchange once a request/response update for the same id arrives', () => {
    const fake = fakeDashboardConnection();
    const store = createBreakpointResumeStore(fake.connection);
    fake.emit({ type: 'breakpoint', exchange: exchange(), payload });

    fake.emit({ type: 'request', exchange: exchange() });

    expect(store.getState().pausedBreakpoints['a']).toBeUndefined();
  });

  it('sends the expected wire message for each action', () => {
    const fake = fakeDashboardConnection();
    const store = createBreakpointResumeStore(fake.connection);
    store.getState().resumeBreakpointRequest('a', { method: 'POST' });
    store.getState().resumeBreakpointResponse('a', { status: 204 });
    store.getState().abortBreakpoint('a', 'response');

    expect(fake.sent).toEqual([
      { type: 'breakpointResume', command: { id: 'a', phase: 'request', action: 'resume', edits: { method: 'POST' } } },
      {
        type: 'breakpointResume',
        command: { id: 'a', phase: 'response', action: 'resume', edits: { status: 204 } },
      },
      { type: 'breakpointResume', command: { id: 'a', phase: 'response', action: 'abort' } },
    ]);
  });
});
