import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createGrpcSchemaStore } from './createGrpcSchemaStore';

describe('createGrpcSchemaStore', () => {
  // Faked only for the one test below that asserts `schemaAt` advances
  // between two `emit`s in the same test — real time can land both within
  // the same `Date.now()` millisecond on a fast machine.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts with no schema', () => {
    const { connection } = fakeDashboardConnection();
    const store = createGrpcSchemaStore(connection);
    expect(store.getState().schema).toBeNull();
    expect(store.getState().schemaAt).toBeNull();
  });

  it('applies a `protoSchema` message, including null (no --proto configured), bumping schemaAt each time', () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createGrpcSchemaStore(connection);

    emit({ type: 'protoSchema', schema: { nested: { helloworld: {} } } });
    expect(store.getState().schema).toEqual({ nested: { helloworld: {} } });
    const first = store.getState().schemaAt;
    expect(first).toEqual(expect.any(Number));

    vi.advanceTimersByTime(1);
    emit({ type: 'protoSchema', schema: null });
    expect(store.getState().schema).toBeNull();
    expect(store.getState().schemaAt).not.toBeNull();
    expect(store.getState().schemaAt).not.toBe(first);
  });

  it('ignores unrelated message types', () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createGrpcSchemaStore(connection);

    emit({ type: 'rules', data: null });
    expect(store.getState().schema).toBeNull();
    expect(store.getState().schemaAt).toBeNull();
  });
});
