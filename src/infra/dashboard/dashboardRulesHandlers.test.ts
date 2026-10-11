import { describe, expect, it, vi } from 'vitest';
import type { Rule, RulesFile } from '../../domain/rules/types';
import type { RuleProfileStore } from '../../usecase/ports/ruleProfileStore';
import type { RuleEngine } from '../../usecase/ruleEngine';
import { createRulesHandlers } from './dashboardRulesHandlers';

const mock: Rule = { name: 'm', match: {}, action: { type: 'mock', status: 200 } } as unknown as Rule;
const script = (path: string): Rule => ({ name: 's', match: {}, action: { type: 'script', path } }) as unknown as Rule;

function fakeEngine(active: Rule[] = []) {
  const write = vi.fn();
  const engine = { getRules: () => active, write } as unknown as RuleEngine;
  return { engine, write };
}

function setup(options: { engine?: RuleEngine; ensured?: RuleEngine; store?: Partial<RuleProfileStore> | null } = {}) {
  const broadcast = vi.fn();
  const broadcastError = vi.fn();
  const ensureRuleEngine = vi.fn(() => options.ensured);
  const store = options.store === null ? undefined : ({ list: () => [], ...options.store } as RuleProfileStore);
  const handlers = createRulesHandlers({
    getRuleEngine: () => options.engine,
    ensureRuleEngine,
    ruleProfileStore: store,
    broadcast,
    broadcastError,
    ruleProfilesMessage: () => ({ type: 'ruleProfiles', profiles: [] }) as never,
  });
  return { handlers, broadcast, broadcastError, ensureRuleEngine };
}

const data = (rules: Rule[]): RulesFile => ({ rules });

describe('dashboard rules handlers (issue #207)', () => {
  describe('setRules', () => {
    it('reports an error when the session has no rules file', () => {
      const { handlers, broadcastError } = setup();
      handlers.setRules({ type: 'setRules', data: data([mock]) });
      expect(broadcastError).toHaveBeenCalledWith('RULES_WRITE_ERROR', 'No rules file is configured for this session.');
    });

    it('writes the rules (without an active profile) when nothing is rejected', () => {
      const { engine, write } = fakeEngine();
      const { handlers, broadcastError } = setup({ engine });
      handlers.setRules({ type: 'setRules', data: data([mock]) });
      expect(write).toHaveBeenCalledWith([mock]);
      expect(broadcastError).not.toHaveBeenCalled();
    });

    it('refuses a write that adds a script rule, and writes nothing (issue #161)', () => {
      const { engine, write } = fakeEngine([mock]);
      const { handlers, broadcastError } = setup({ engine });
      handlers.setRules({ type: 'setRules', data: data([mock, script('evil.js')]) });
      expect(write).not.toHaveBeenCalled();
      expect(broadcastError).toHaveBeenCalledWith(
        'RULES_WRITE_ERROR',
        expect.stringContaining('adding a new `script` rule'),
      );
    });

    it('turns a failing write into an error broadcast instead of throwing', () => {
      const { engine, write } = fakeEngine();
      write.mockImplementation(() => {
        throw new Error('disk full');
      });
      const { handlers, broadcastError } = setup({ engine });
      expect(() => handlers.setRules({ type: 'setRules', data: data([mock]) })).not.toThrow();
      expect(broadcastError).toHaveBeenCalledWith('RULES_WRITE_ERROR', 'disk full');
    });
  });

  describe('createRuleProfile', () => {
    it('reports profiles as unavailable without a store', () => {
      const { handlers, broadcastError } = setup({ store: null });
      handlers.createRuleProfile({ type: 'createRuleProfile', name: 'a', template: 'blank' });
      expect(broadcastError).toHaveBeenCalledWith('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
    });

    it('creates an empty profile and tells every client', () => {
      const write = vi.fn();
      const { handlers, broadcast } = setup({ store: { write } });
      handlers.createRuleProfile({ type: 'createRuleProfile', name: 'a', template: 'blank' });
      expect(write).toHaveBeenCalledWith('a', { rules: [] });
      expect(broadcast).toHaveBeenCalledWith({ type: 'ruleProfiles', profiles: [] });
    });
  });

  describe('saveActiveRulesAsProfile', () => {
    it('snapshots the active rules and marks them as that profile', () => {
      const { engine, write: engineWrite } = fakeEngine([mock]);
      const write = vi.fn();
      const { handlers, broadcast } = setup({ engine, store: { write } });
      handlers.saveActiveRulesAsProfile({ type: 'saveActiveRulesAsProfile', name: 'snap' });
      expect(write).toHaveBeenCalledWith('snap', { rules: [mock] });
      expect(engineWrite).toHaveBeenCalledWith([mock], { activeProfile: 'snap' });
      expect(broadcast).toHaveBeenCalled();
    });

    it('is unavailable without a rule engine', () => {
      const { handlers, broadcastError } = setup({ store: { write: vi.fn() } });
      handlers.saveActiveRulesAsProfile({ type: 'saveActiveRulesAsProfile', name: 'snap' });
      expect(broadcastError).toHaveBeenCalledWith('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
    });
  });

  describe('applyRuleProfile', () => {
    it('does not provision a rule engine when there is no profile store', () => {
      const { handlers, ensureRuleEngine, broadcastError } = setup({ store: null });
      handlers.applyRuleProfile({ type: 'applyRuleProfile', name: 'p' });
      expect(ensureRuleEngine).not.toHaveBeenCalled();
      expect(broadcastError).toHaveBeenCalledWith('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
    });

    it('lazily provisions an engine and applies the profile as the active one', () => {
      const { engine, write } = fakeEngine();
      const { handlers, ensureRuleEngine } = setup({ ensured: engine, store: { read: () => data([mock]) } });
      handlers.applyRuleProfile({ type: 'applyRuleProfile', name: 'p' });
      expect(ensureRuleEngine).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledWith([mock], { activeProfile: 'p' });
    });

    it('refuses a profile that would resurrect a script rule, and writes nothing (issue #161)', () => {
      const { engine, write } = fakeEngine([mock]);
      const { handlers, broadcastError } = setup({
        ensured: engine,
        store: { read: () => data([script('old.js')]) },
      });
      handlers.applyRuleProfile({ type: 'applyRuleProfile', name: 'p' });
      expect(write).not.toHaveBeenCalled();
      expect(broadcastError).toHaveBeenCalledWith(
        'RULE_PROFILE_ERROR',
        expect.stringContaining('adding a new `script` rule'),
      );
    });

    it('reports a failing engine factory instead of dropping the message', () => {
      const { handlers, broadcastError, ensureRuleEngine } = setup({ store: { read: () => data([]) } });
      ensureRuleEngine.mockImplementation(() => {
        throw new Error('cannot write rules file');
      });
      handlers.applyRuleProfile({ type: 'applyRuleProfile', name: 'p' });
      expect(broadcastError).toHaveBeenCalledWith('RULE_PROFILE_ERROR', 'cannot write rules file');
    });
  });
});
