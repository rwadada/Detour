import type WebSocket from 'ws';
import type { DashboardClientMessage, DashboardServerMessage } from '../../domain/dashboard/protocol';
import { hashPassword } from '../../domain/auth/passwordHash';
import type { CapturedExchange } from '../../domain/exchange/types';
import { toWireExchange } from '../../domain/exchange/wireExchange';
import type { DetourEventBus } from '../eventBus';
import type { writeUserConfig } from '../fs/userConfigStore';
import { describeError, type RulesHandlers } from './dashboardRulesHandlers';

type MessageOf<T extends DashboardClientMessage['type']> = Extract<DashboardClientMessage, { type: T }>;

/** Every message an authenticated socket may send (`login` is answered before authentication, never here). */
export type AuthenticatedMessageType = Exclude<DashboardClientMessage['type'], 'login'>;

/**
 * One handler per authenticated message `type`. A `Record` over the whole union, so a message type added to the
 * protocol without a handler here fails the typecheck instead of being silently ignored (issue #207).
 */
export type MessageHandlerTable = {
  [T in AuthenticatedMessageType]: (message: MessageOf<T>, socket: WebSocket) => void | Promise<void>;
};

/** What the handlers need from the dashboard server — everything else stays inside its closure. */
export interface MessageHandlerDeps {
  eventBus: DetourEventBus;
  rules: RulesHandlers;
  broadcast: (message: DashboardServerMessage) => void;
  broadcastError: (errorKind: string, message: string) => void;
  userConfigMessage: () => DashboardServerMessage;
  sendUpdateInfoToAll: () => void;
  /** Persists a user-config change (the server fills in the file path). Throws on a write failure. */
  persistUserConfig: (patch: Parameters<typeof writeUserConfig>[0]) => void;
  /** Called with the new hash after a successful password change, so the server can drop sessions tied to the old one. */
  onDashboardPasswordChanged: (hash: string | null) => void;
  startUpdate: (socket: WebSocket) => Promise<DashboardServerMessage>;
  refreshUpdateInfo: () => Promise<void>;
  /** Asks the Android USB watcher to switch; `false` when it refused, so the caller can snap the client's switch back. */
  setAdbReverse: (socket: WebSocket, enabled: boolean) => boolean;
  sendAdbReverseState: (socket: WebSocket) => void;
  replay: (message: MessageOf<'replay'>) => Promise<void>;
  queryHistory: (
    query: MessageOf<'queryHistory'>['query'],
  ) => { items: CapturedExchange[]; hasMore: boolean } | undefined;
}

/** Runs the handler for `message.type`. The one cast lives here: TypeScript cannot correlate a union member with its handler. */
export function dispatchMessage(
  table: MessageHandlerTable,
  message: Exclude<DashboardClientMessage, { type: 'login' }>,
  socket: WebSocket,
): void | Promise<void> {
  const handler = table[message.type] as (message: DashboardClientMessage, socket: WebSocket) => void | Promise<void>;
  return handler(message, socket);
}

export function createMessageHandlers(deps: MessageHandlerDeps): MessageHandlerTable {
  const { eventBus, rules, broadcast, broadcastError } = deps;

  return {
    breakpointResume: (message) => void eventBus.emit('breakpointResume', message.command),
    setIntercept: (message) => void eventBus.emit('setIntercept', message.enabled),
    setFocus: (message) => void eventBus.emit('setFocus', message.hosts),
    setThrottle: (message) => void eventBus.emit('setThrottle', message.state),
    setBlockHosts: (message) => void eventBus.emit('setBlockHosts', message.state),

    startUpdate: async (_message, socket) => {
      socket.send(JSON.stringify(await deps.startUpdate(socket)));
    },

    checkUpdate: async () => {
      await deps.refreshUpdateInfo();
      deps.sendUpdateInfoToAll();
    },

    setAdbReverse: (message, socket) => {
      // `set` answers every client when it changes something; a refused one gets the state back so its switch snaps back.
      if (!deps.setAdbReverse(socket, message.enabled)) deps.sendAdbReverseState(socket);
    },

    replay: (message) => deps.replay(message),

    setUserConfig: (message) => {
      try {
        deps.persistUserConfig(message.state);
        broadcast(deps.userConfigMessage());
      } catch (err) {
        broadcastError('USER_CONFIG_WRITE_ERROR', describeError(err));
      }
    },

    setDashboardPassword: async (message) => {
      try {
        if (message.password === '') {
          // Silently accepting this would set a real, trivially-guessable password while `dashboardPasswordSet`
          // reports "on" — worse than not setting one at all, since it looks protected.
          throw new Error('Dashboard password must not be empty — pass null to remove it.');
        }
        const dashboardPasswordHash = message.password === null ? null : await hashPassword(message.password);
        deps.persistUserConfig({ dashboardPasswordHash });
        // Updates the server's last known hash (its fail-closed fallback) and drops sessions that logged in with
        // the old password right away, rather than waiting for the next read to catch up — see
        // `onDashboardPasswordChanged` in the server.
        deps.onDashboardPasswordChanged(dashboardPasswordHash);
        deps.sendUpdateInfoToAll();
        broadcast(deps.userConfigMessage());
      } catch (err) {
        broadcastError('USER_CONFIG_WRITE_ERROR', describeError(err));
      }
    },

    queryHistory: (message, socket) => {
      // Sent to the requesting socket only (never `broadcast`) — this answers one tab's own query, not a
      // shared-state change every connected tab needs to hear about. Answered even with no `historyStore`
      // (empty/`hasMore: false`) rather than dropped — see the wire type's own doc comment for why. A query
      // failure (e.g. a corrupt DB file) must still answer with something, same reasoning — otherwise the
      // requester's History UI is stuck showing `loading: true` forever with no way to know why.
      let result: { items: CapturedExchange[]; hasMore: boolean };
      try {
        result = deps.queryHistory(message.query) ?? { items: [], hasMore: false };
      } catch (err) {
        eventBus.emit('error', { errorKind: 'HISTORY_QUERY_ERROR', message: describeError(err) });
        result = { items: [], hasMore: false };
      }
      const reply: DashboardServerMessage = {
        type: 'historyResult',
        requestId: message.requestId,
        items: result.items.map(toWireExchange),
        hasMore: result.hasMore,
      };
      socket.send(JSON.stringify(reply));
    },

    setRules: rules.setRules,
    createRuleProfile: rules.createRuleProfile,
    saveActiveRulesAsProfile: rules.saveActiveRulesAsProfile,
    applyRuleProfile: rules.applyRuleProfile,
  };
}
