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

  it('applies a `rules` message, including `null` (no rules file configured), bumping rulesFileAt each time', () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);
    expect(store.getState().rulesFileAt).toBeNull();

    emit({ type: 'rules', data: rulesFile, unreachableWarnings: [], scriptWarnings: [] });
    expect(store.getState().rulesFile).toEqual(rulesFile);
    const first = store.getState().rulesFileAt;
    expect(first).toEqual(expect.any(Number));

    emit({ type: 'rules', data: null, unreachableWarnings: [], scriptWarnings: [] });
    expect(store.getState().rulesFile).toBeNull();
    expect(store.getState().rulesFileAt).not.toBeNull();
  });

  it("applies a `rules` message's `unreachableWarnings`", () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);
    const warning = {
      ruleName: 'dead',
      ruleIndex: 1,
      blockedByName: 'catch-all',
      blockedByIndex: 0,
      message:
        'rule "dead" (index 1) can never match: rule "catch-all" (index 0) already matches every request "dead" would, and — being a mock/route/breakpoint/script rule — stops evaluation there.',
    };
    emit({ type: 'rules', data: rulesFile, unreachableWarnings: [warning], scriptWarnings: [] });
    expect(store.getState().unreachableWarnings).toEqual([warning]);
  });

  it("defaults `unreachableWarnings` to an empty array when a `rules` message omits it (Copilot review, PR #150: an older server or a malformed frame could leave it undefined, crashing RulesEditorPanel's `.find(...)` call)", () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);
    // `message.unreachableWarnings` being present is a compile-time
    // assumption, not a runtime one — deliberately bypassing the type here
    // to exercise the case the field is actually missing off the wire.
    emit({ type: 'rules', data: rulesFile } as unknown as Parameters<typeof emit>[0]);
    expect(store.getState().unreachableWarnings).toEqual([]);
  });

  it("applies a `rules` message's `scriptWarnings`, defaulting to an empty array when omitted (issue #161, same reasoning as `unreachableWarnings` above)", () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);
    const scriptWarning = {
      ruleName: 's1',
      ruleIndex: 0,
      message: 'rule "s1" (index 0): `script` actions are disabled — pass --allow-scripts to run it.',
    };
    emit({ type: 'rules', data: rulesFile, unreachableWarnings: [], scriptWarnings: [scriptWarning] });
    expect(store.getState().scriptWarnings).toEqual([scriptWarning]);

    emit({ type: 'rules', data: rulesFile, unreachableWarnings: [] } as unknown as Parameters<typeof emit>[0]);
    expect(store.getState().scriptWarnings).toEqual([]);
  });

  it('applies a `ruleProfiles` message, bumping profilesAt', () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);
    expect(store.getState().profilesAt).toBeNull();

    emit({ type: 'ruleProfiles', profiles: [{ name: 'staging', ruleCount: 3, updatedAt: 1 }] });

    expect(store.getState().profiles).toEqual([{ name: 'staging', ruleCount: 3, updatedAt: 1 }]);
    expect(store.getState().profilesAt).toEqual(expect.any(Number));
  });

  it('surfaces RULES_WRITE_ERROR / RULE_PROFILE_ERROR as lastError, dismissable', () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);

    emit({ type: 'error', event: { errorKind: 'RULES_WRITE_ERROR', message: 'bad rule' } });
    expect(store.getState().lastError).toBe('bad rule');
    expect(store.getState().lastErrorAt).toEqual(expect.any(Number));
    expect(store.getState().lastErrorKind).toBe('RULES_WRITE_ERROR');

    store.getState().dismissError();
    expect(store.getState().lastError).toBeNull();
    expect(store.getState().lastErrorAt).toBeNull();
    expect(store.getState().lastErrorKind).toBeNull();

    emit({ type: 'error', event: { errorKind: 'RULE_PROFILE_ERROR', message: 'name taken' } });
    expect(store.getState().lastError).toBe('name taken');
    expect(store.getState().lastErrorKind).toBe('RULE_PROFILE_ERROR');
  });

  it('lastErrorAt moves forward on each new error, letting a consumer tell a fresh one from a stale one it already saw', () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);

    emit({ type: 'error', event: { errorKind: 'RULE_PROFILE_ERROR', message: 'first' } });
    const first = store.getState().lastErrorAt;

    emit({ type: 'error', event: { errorKind: 'RULE_PROFILE_ERROR', message: 'second' } });
    const second = store.getState().lastErrorAt;

    expect(second).not.toBeNull();
    expect(second).toBeGreaterThanOrEqual(first ?? Number.NaN);
  });

  it('ignores unrelated error kinds', () => {
    const { connection, emit } = fakeDashboardConnection();
    const store = createRuleStore(connection);

    emit({ type: 'error', event: { errorKind: 'PROXY_CONNECT_ERROR', message: 'unrelated' } });

    expect(store.getState().lastError).toBeNull();
  });

  it('queueNewRule()/clearPendingNewRule() manage pendingNewRule', () => {
    const { connection } = fakeDashboardConnection();
    const store = createRuleStore(connection);
    expect(store.getState().pendingNewRule).toBeNull();

    const rule = { name: 'r1', match: { url: '*' }, action: { type: 'mock' as const, status: 200 } };
    store.getState().queueNewRule(rule);
    expect(store.getState().pendingNewRule).toEqual(rule);

    store.getState().clearPendingNewRule();
    expect(store.getState().pendingNewRule).toBeNull();
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
