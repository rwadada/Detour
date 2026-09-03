import { describe, expect, it } from 'vitest';
import { fakeDashboardConnection } from '@/shared/api';
import { createRuleStore } from './createRuleStore';

const rulesFile = {
  rules: [{ name: 'r1', match: { url: 'https://x/*' }, action: { type: 'route' as const, host: 'y' } }],
};

describe('createRuleStore', () => {
  it('starts with no rules file and no profiles', () => {
    const { connection } = fakeDashboardConnection();
    const store = createRuleStore(connection);
    expect(store.getState().rulesFile).toBeNull();
    expect(store.getState().profiles).toEqual([]);
  });

  it('applies a `rules` message, including `null` (no rules file configured)', () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);

    emit({ type: 'rules', data: rulesFile });
    expect(store.getState().rulesFile).toEqual(rulesFile);

    emit({ type: 'rules', data: null });
    expect(store.getState().rulesFile).toBeNull();
  });

  it('applies a `ruleProfiles` message', () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);

    emit({ type: 'ruleProfiles', profiles: [{ name: 'staging', ruleCount: 3, updatedAt: 1 }] });

    expect(store.getState().profiles).toEqual([{ name: 'staging', ruleCount: 3, updatedAt: 1 }]);
  });

  it('surfaces RULES_WRITE_ERROR / RULE_PROFILE_ERROR as lastError, dismissable', () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);

    emit({ type: 'error', event: { errorKind: 'RULES_WRITE_ERROR', message: 'bad rule' } });
    expect(store.getState().lastError).toBe('bad rule');

    store.getState().dismissError();
    expect(store.getState().lastError).toBeNull();

    emit({ type: 'error', event: { errorKind: 'RULE_PROFILE_ERROR', message: 'name taken' } });
    expect(store.getState().lastError).toBe('name taken');
  });

  it('ignores unrelated error kinds', () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);

    emit({ type: 'error', event: { errorKind: 'PROXY_CONNECT_ERROR', message: 'unrelated' } });

    expect(store.getState().lastError).toBeNull();
  });

  it('setRules()/createProfile()/saveActiveAsProfile()/applyProfile() send the matching command', () => {
    const { connection, sent } = fakeDashboardConnection();
    const store = createRuleStore(connection);

    store.getState().setRules(rulesFile);
    store.getState().createProfile('staging', 'sample');
    store.getState().saveActiveAsProfile('snapshot');
    store.getState().applyProfile('staging');

    expect(sent).toEqual([
      { type: 'setRules', data: rulesFile },
      { type: 'createRuleProfile', name: 'staging', template: 'sample' },
      { type: 'saveActiveRulesAsProfile', name: 'snapshot' },
      { type: 'applyRuleProfile', name: 'staging' },
    ]);
  });
});
