import { createLogStore } from './createLogStore';

export * from './createLogStore';

/**
 * The app's real log store: `createLogStore` (see createLogStore.ts) wired
 * to the real dashboard WebSocket connection. This is the dashboard's
 * composition root for state — the one place that constructs the real
 * connector, mirroring how `src/cli.ts` wires the real Infrastructure
 * adapters into the CLI's UseCases. Every component imports `useLogStore`
 * from here (unchanged); tests import `createLogStore` directly from
 * createLogStore.ts instead, to supply a fake connector.
 */
export const useLogStore = createLogStore();
