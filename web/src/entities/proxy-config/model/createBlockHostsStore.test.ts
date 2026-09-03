import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createBlockHostsStore, DEFAULT_BLOCK_HOSTS_STATE } from './createBlockHostsStore';

describe('createBlockHostsStore', () => {
  it('defaults to an empty (unblocked) denylist', () => {
    const fake = fakeDashboardConnection();
    const store = createBlockHostsStore(fake.connection);
    expect(store.getState().blockHosts).toEqual(DEFAULT_BLOCK_HOSTS_STATE);
  });

  it('mirrors the server-pushed denylist', () => {
    const fake = fakeDashboardConnection();
    const store = createBlockHostsStore(fake.connection);
    fake.emit({ type: 'blockHosts', state: { hosts: ['a.com', 'b.com'], mode: 'reset' } });
    expect(store.getState().blockHosts).toEqual({ hosts: ['a.com', 'b.com'], mode: 'reset' });
  });

  it('setBlockHosts sends a setBlockHosts command', () => {
    const fake = fakeDashboardConnection();
    const store = createBlockHostsStore(fake.connection);
    store.getState().setBlockHosts({ hosts: ['a.com'], mode: 'forbidden' });
    expect(fake.sent).toEqual([{ type: 'setBlockHosts', state: { hosts: ['a.com'], mode: 'forbidden' } }]);
  });
});
