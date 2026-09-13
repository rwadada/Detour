import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createGrpcSchemaStore } from './createGrpcSchemaStore';

describe('createGrpcSchemaStore', () => {
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
