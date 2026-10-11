import type WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import type { CapturedExchange } from '../../domain/exchange/types';
import { DetourEventBus } from '../eventBus';
import { createMessageHandlers, type MessageHandlerDeps } from './dashboardMessageHandlers';
import type { RulesHandlers } from './dashboardRulesHandlers';

function fakeSocket() {
  const send = vi.fn();
  return { socket: { send } as unknown as WebSocket, send };
}

function setup(overrides: Partial<MessageHandlerDeps> = {}) {
  const eventBus = new DetourEventBus();
  const rules: RulesHandlers = {
    setRules: vi.fn(),
    createRuleProfile: vi.fn(),
    saveActiveRulesAsProfile: vi.fn(),
    applyRuleProfile: vi.fn(),
  };
  const deps: MessageHandlerDeps = {
    eventBus,
    rules,
    broadcast: vi.fn(),
    broadcastError: vi.fn(),
    userConfigMessage: () => ({ type: 'userConfig' }) as never,
    sendUpdateInfoToAll: vi.fn(),
    persistUserConfig: vi.fn(),
    onDashboardPasswordChanged: vi.fn(),
    startUpdate: vi.fn(),
    refreshUpdateInfo: vi.fn(async () => {}),
    setAdbReverse: vi.fn(() => true),
    sendAdbReverseState: vi.fn(),
    replay: vi.fn(async () => {}),
    queryHistory: vi.fn(),
    ...overrides,
  };
  return { handlers: createMessageHandlers(deps), deps, eventBus, rules };
}

describe('dashboard message handlers (issue #207)', () => {
  it('turns a control message into the matching event-bus event', () => {
    const { handlers, eventBus } = setup();
    const seen = vi.fn();
    eventBus.on('setIntercept', seen);
    handlers.setIntercept({ type: 'setIntercept', enabled: true }, fakeSocket().socket);
    expect(seen).toHaveBeenCalledWith(true);
  });

  it('hands the rules messages to the rules handlers', () => {
    const { handlers, rules } = setup();
    const message = { type: 'applyRuleProfile', name: 'p' } as const;
    handlers.applyRuleProfile(message, fakeSocket().socket);
    expect(rules.applyRuleProfile).toHaveBeenCalledWith(message, expect.anything());
  });

  describe('setAdbReverse', () => {
    it('sends the state back to a client whose switch was refused', () => {
      const { handlers, deps } = setup({ setAdbReverse: vi.fn(() => false) });
      const { socket } = fakeSocket();
      handlers.setAdbReverse({ type: 'setAdbReverse', enabled: true }, socket);
      expect(deps.sendAdbReverseState).toHaveBeenCalledWith(socket);
    });

    it('stays quiet when the switch was accepted (the watcher answers every client)', () => {
      const { handlers, deps } = setup();
      handlers.setAdbReverse({ type: 'setAdbReverse', enabled: true }, fakeSocket().socket);
      expect(deps.sendAdbReverseState).not.toHaveBeenCalled();
    });
  });

  describe('setUserConfig', () => {
    it('persists then broadcasts the new config', () => {
      const { handlers, deps } = setup();
      handlers.setUserConfig({ type: 'setUserConfig', state: {} as never }, fakeSocket().socket);
      expect(deps.persistUserConfig).toHaveBeenCalled();
      expect(deps.broadcast).toHaveBeenCalledWith({ type: 'userConfig' });
    });

    it('reports a write failure to every client instead of throwing', () => {
      const persistUserConfig = vi.fn(() => {
        throw new Error('read-only fs');
      });
      const { handlers, deps } = setup({ persistUserConfig });
      handlers.setUserConfig({ type: 'setUserConfig', state: {} as never }, fakeSocket().socket);
      expect(deps.broadcastError).toHaveBeenCalledWith('USER_CONFIG_WRITE_ERROR', 'read-only fs');
      expect(deps.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('setDashboardPassword', () => {
    it('refuses an empty password: it would look protected while being trivially guessable', async () => {
      const { handlers, deps } = setup();
      await handlers.setDashboardPassword({ type: 'setDashboardPassword', password: '' }, fakeSocket().socket);
      expect(deps.persistUserConfig).not.toHaveBeenCalled();
      expect(deps.onDashboardPasswordChanged).not.toHaveBeenCalled();
      expect(deps.broadcastError).toHaveBeenCalledWith('USER_CONFIG_WRITE_ERROR', expect.stringContaining('empty'));
    });

    it('stores a hash (never the password) and drops sessions tied to the old one', async () => {
      const { handlers, deps } = setup();
      await handlers.setDashboardPassword({ type: 'setDashboardPassword', password: 'hunter2' }, fakeSocket().socket);
      const [patch] = vi.mocked(deps.persistUserConfig).mock.calls[0]!;
      expect(JSON.stringify(patch)).not.toContain('hunter2');
      expect(vi.mocked(deps.onDashboardPasswordChanged).mock.calls[0]![0]).toEqual(expect.any(String));
      expect(deps.sendUpdateInfoToAll).toHaveBeenCalled();
      expect(deps.broadcast).toHaveBeenCalledWith({ type: 'userConfig' });
    });

    it('removes the password with null', async () => {
      const { handlers, deps } = setup();
      await handlers.setDashboardPassword({ type: 'setDashboardPassword', password: null }, fakeSocket().socket);
      expect(deps.persistUserConfig).toHaveBeenCalledWith({ dashboardPasswordHash: null });
      expect(deps.onDashboardPasswordChanged).toHaveBeenCalledWith(null);
    });
  });

  describe('queryHistory', () => {
    const query = { type: 'queryHistory', requestId: 7, query: {} } as never;

    it('answers only the asking socket, with wire-format items', () => {
      const exchange = { id: 'e1' } as unknown as CapturedExchange;
      const { handlers, deps } = setup({ queryHistory: vi.fn(() => ({ items: [], hasMore: true })) });
      const { socket, send } = fakeSocket();
      handlers.queryHistory(query, socket);
      expect(JSON.parse(send.mock.calls[0]![0])).toEqual({
        type: 'historyResult',
        requestId: 7,
        items: [],
        hasMore: true,
      });
      expect(deps.broadcast).not.toHaveBeenCalled();
      expect(exchange).toBeDefined();
    });

    it('answers with an empty result when there is no history store', () => {
      const { handlers } = setup();
      const { socket, send } = fakeSocket();
      handlers.queryHistory(query, socket);
      expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({ items: [], hasMore: false });
    });

    it('answers empty and reports the failure when the query throws, so the History UI is not stuck loading', () => {
      const { handlers, eventBus } = setup({
        queryHistory: vi.fn(() => {
          throw new Error('corrupt db');
        }),
      });
      const errors = vi.fn();
      eventBus.on('error', errors);
      const { socket, send } = fakeSocket();
      handlers.queryHistory(query, socket);
      expect(errors).toHaveBeenCalledWith({ errorKind: 'HISTORY_QUERY_ERROR', message: 'corrupt db' });
      expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({ items: [], hasMore: false });
    });
  });

  describe('startUpdate / checkUpdate', () => {
    it('sends the updater state to the requesting socket', async () => {
      const state = { type: 'updateStatus', state: 'started' } as never;
      const { handlers } = setup({ startUpdate: vi.fn(async () => state) });
      const { socket, send } = fakeSocket();
      await handlers.startUpdate({ type: 'startUpdate' }, socket);
      expect(JSON.parse(send.mock.calls[0]![0])).toEqual(state);
    });

    it('refreshes the cached update info, then tells every client', async () => {
      const { handlers, deps } = setup();
      await handlers.checkUpdate({ type: 'checkUpdate' }, fakeSocket().socket);
      expect(deps.refreshUpdateInfo).toHaveBeenCalled();
      expect(deps.sendUpdateInfoToAll).toHaveBeenCalled();
    });
  });
});
