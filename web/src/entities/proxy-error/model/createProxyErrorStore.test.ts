import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createProxyErrorStore } from './createProxyErrorStore';

describe('createProxyErrorStore', () => {
  it('caps stored errors at MAX_ERRORS, newest first', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyErrorStore(fake.connection);
    fake.emit({ type: 'error', event: { errorKind: 'A', message: 'first' } });
    fake.emit({ type: 'error', event: { errorKind: 'B', message: 'second' } });
    expect(store.getState().errors.map((e) => e.message)).toEqual(['second', 'first']);
  });

  it('ignores unrelated message types', () => {
    const fake = fakeDashboardConnection();
    const store = createProxyErrorStore(fake.connection);
    fake.emit({ type: 'intercept', state: { enabled: false } });
    expect(store.getState().errors).toEqual([]);
  });
});
