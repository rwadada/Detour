/**
 * The dashboard WebSocket protocol is written twice: `src/domain/dashboard/protocol.ts` for the server
 * and `web/src/shared/api/protocol.ts` for the page (which cannot import from `src/`). Nothing used to
 * notice when one was edited without the other (issue #209). This file makes the type checker do it, via
 * `tsc -p tsconfig.protocol-parity.json` (part of `npm run typecheck`). It checks types only — nothing
 * here runs.
 *
 * The contract is directional, not "identical": a message must be acceptable to whoever receives it.
 *
 *  - server -> page: everything the server sends must be assignable to what the page accepts.
 *  - page -> server: everything the page sends must be assignable to what the server accepts.
 *
 * so the receiving side may be the looser one. That is deliberate in one place today: the page types
 * `proxyInfo.insecureUpstream` and `protocolVersion` as optional because an older server predates them,
 * while the server always sends both. A field the sender omits that the receiver requires, a field the
 * sender can send that the receiver does not know, or a message `type` only one side has, fails here.
 *
 * Assignability alone cannot see a field one side has and the other lacks (TypeScript lets an object with
 * extra properties through), so each message's set of field NAMES is compared as well.
 *
 * A failure names the message `type` (or the type) that differs.
 */
import type * as Server from '../src/domain/dashboard/protocol';
import type * as Web from '../web/src/shared/api/protocol';

/** Compile error unless T is `true`. The error shows which pair failed, since `T` is in the message. */
type Assert<T extends true> = T;
/** `true` when every value of A is acceptable as a B. */
type Sendable<A, B> = [A] extends [B] ? true : false;

type ServerMessage = Server.DashboardServerMessage;
type PageMessage = Web.DashboardServerMessage;
type ClientMessage = Server.DashboardClientMessage;
type PageClientMessage = Web.DashboardClientMessage;

type Of<M, T> = Extract<M, { type: T }>;

/** `true` only if every message `type` of one union is a `type` of the other, and the reverse. */
type SameTypes<A extends { type: string }, B extends { type: string }> = [A['type']] extends [B['type']]
  ? [B['type']] extends [A['type']]
    ? true
    : false
  : false;

/** For each server -> page `type`, whether the page accepts what the server sends. Any `false` shows up by name. */
type ServerToPage = { [T in ServerMessage['type']]: Sendable<Of<ServerMessage, T>, Of<PageMessage, T>> };
/** For each page -> server `type`, whether the server accepts what the page sends. */
type PageToServer = { [T in PageClientMessage['type']]: Sendable<Of<PageClientMessage, T>, Of<ClientMessage, T>> };

/** For each `type` in both directions, whether server and page agree on which fields the message has. */
type KeysOf<M, T> = keyof Of<M, T>;
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type ServerFieldNames = { [T in ServerMessage['type']]: SameKeys<KeysOf<ServerMessage, T>, KeysOf<PageMessage, T>> };
type ClientFieldNames = {
  [T in ClientMessage['type']]: SameKeys<KeysOf<ClientMessage, T>, KeysOf<PageClientMessage, T>>;
};

/** The names of the `false` entries (`never` when every one is `true`), for a readable error. */
type Failing<M extends Record<string, boolean>> = { [K in keyof M]: M[K] extends true ? never : K }[keyof M];
type NoneFailing<M extends Record<string, boolean>> = [Failing<M>] extends [never] ? true : Failing<M>;

export type Checks = [
  // Same set of message types on both sides, in both directions of travel.
  Assert<SameTypes<ServerMessage, PageMessage>>,
  Assert<SameTypes<ClientMessage, PageClientMessage>>,
  // Every message the server sends is acceptable to the page — if not, the type name is in the error.
  Assert<NoneFailing<ServerToPage>>,
  // Every message the page sends is acceptable to the server.
  Assert<NoneFailing<PageToServer>>,
  // The same fields on each message, in both directions (what assignability cannot see).
  Assert<NoneFailing<ServerFieldNames>>,
  Assert<NoneFailing<ClientFieldNames>>,
  // Shapes the server exports under the same name, sent in either direction.
  Assert<Sendable<Server.HistoryFilters, Web.HistoryFilters>>,
  Assert<Sendable<Web.HistoryFilters, Server.HistoryFilters>>,
  Assert<Sendable<Web.HistoryQuery, Server.HistoryQuery>>,
  Assert<Sendable<Web.ReplayOverrides, Server.ReplayOverrides>>,
  Assert<Sendable<Server.UserConfigState, Web.UserConfigState>>,
  Assert<Sendable<Web.UserConfigState, Server.UserConfigState>>,
  // The version the server stamps on `proxyInfo` is the one the page compares against.
  Assert<Sendable<typeof Server.PROTOCOL_VERSION, typeof Web.PROTOCOL_VERSION>>,
];
