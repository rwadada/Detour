import { create } from 'zustand';
import type { DashboardConnection } from '@/shared/api';

export interface GrpcSchemaState {
  /** The `--proto` schema's JSON descriptor for this session, or `null` if none was configured, or the initial `protoSchema` message hasn't arrived yet — from the consumer's own perspective these two `null` cases look identical (nothing to decode with), so unlike `entities/rule`'s `rulesFile` there's no separate "loading" state to distinguish here. */
  schema: Record<string, unknown> | null;
  /** `Date.now()` when `schema` was last set — mirrors `entities/rule`'s `rulesFileAt`, though nothing here currently needs it: a `--proto` schema has no live-reload (see `protoSchema`'s own doc comment on `DashboardServerMessage`), so it's only ever set once. Kept for parity/future-proofing rather than because a consumer resolves a dispatched request against it today. */
  schemaAt: number | null;
}

/**
 * Builds the gRPC entity's store: the `--proto` schema this session loaded,
 * if any (issue #18's dashboard follow-up). Subscribes to the given
 * `DashboardConnection` for the one `protoSchema` message it ever sends —
 * see `entities/exchange/model/createExchangeStore.ts` for why `connection`
 * is a required parameter.
 */
export function createGrpcSchemaStore(connection: DashboardConnection) {
  return create<GrpcSchemaState>((set) => {
    connection.onMessage((message) => {
      if (message.type === 'protoSchema') set({ schema: message.schema, schemaAt: Date.now() });
    });

    return {
      schema: null,
      schemaAt: null,
    };
  });
}
