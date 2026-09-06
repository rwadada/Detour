import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createUserConfigStore } from './createUserConfigStore';

describe('createUserConfigStore', () => {
  it('starts undefined until the server’s first userConfig message arrives', () => {
    const fake = fakeDashboardConnection();
    const store = createUserConfigStore(fake.connection);
    expect(store.getState().userConfig).toBeUndefined();
  });

  it('mirrors the server-pushed userConfig state', () => {
    const fake = fakeDashboardConnection();
    const store = createUserConfigStore(fake.connection);
    fake.emit({ type: 'userConfig', state: { defaultDetach: true, lanAccess: false, dashboardPasswordSet: false } });
    expect(store.getState().userConfig).toEqual({
      defaultDetach: true,
      lanAccess: false,
      dashboardPasswordSet: false,
    });
  });

  it('setUserConfig sends a setUserConfig command with just the changed field', () => {
    const fake = fakeDashboardConnection();
    const store = createUserConfigStore(fake.connection);
    store.getState().setUserConfig({ lanAccess: true });
    expect(fake.sent).toEqual([{ type: 'setUserConfig', state: { lanAccess: true } }]);
  });

  it('setDashboardPassword sends a setDashboardPassword command', () => {
    const fake = fakeDashboardConnection();
    const store = createUserConfigStore(fake.connection);
    store.getState().setDashboardPassword('hunter2');
    expect(fake.sent).toEqual([{ type: 'setDashboardPassword', password: 'hunter2' }]);
  });

  it('setDashboardPassword(null) sends a clear command', () => {
    const fake = fakeDashboardConnection();
    const store = createUserConfigStore(fake.connection);
    store.getState().setDashboardPassword(null);
    expect(fake.sent).toEqual([{ type: 'setDashboardPassword', password: null }]);
  });
});
