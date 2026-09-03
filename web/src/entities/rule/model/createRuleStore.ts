import { create } from 'zustand';
import type { DashboardConnection, RuleProfileSummary, RulesFile } from '@/shared/api';

export interface RuleState {
  /** The currently active rules.json contents, or `null` if this session has no rules file configured, or the initial `rules` message hasn't arrived yet. */
  rulesFile: RulesFile | null;
  /** Saved rule profiles (issue #19's Rules Profiles), available to apply or overwrite. */
  profiles: RuleProfileSummary[];
  /** The most recent `RULES_WRITE_ERROR`/`RULE_PROFILE_ERROR` message from the server, if any hasn't been dismissed yet. */
  lastError: string | null;
  /** Saves edits to the active rules.json (Rules editor). */
  setRules: (data: RulesFile) => void;
  /** Creates a new saved profile from a template. */
  createProfile: (name: string, template: 'blank' | 'sample') => void;
  /** Saves the currently active rules as a named profile (creating or overwriting it). */
  saveActiveAsProfile: (name: string) => void;
  /** Loads a saved profile's rules into the active rules.json. */
  applyProfile: (name: string) => void;
  dismissError: () => void;
}

/**
 * Builds the rule entity's store: the active rules.json contents and saved
 * profiles (issue #19's Rules editor / Rules Profiles). Subscribes to the
 * given `DashboardConnection` for `rules`/`ruleProfiles`/`error` messages —
 * see `entities/exchange/model/createExchangeStore.ts` for why `connection`
 * is a required parameter.
 */
export function createRuleStore(connection: DashboardConnection) {
  return create<RuleState>((set) => {
    connection.onMessage((message) => {
      switch (message.type) {
        case 'rules':
          set({ rulesFile: message.data });
          return;
        case 'ruleProfiles':
          set({ profiles: message.profiles });
          return;
        case 'error':
          if (message.event.errorKind === 'RULES_WRITE_ERROR' || message.event.errorKind === 'RULE_PROFILE_ERROR') {
            set({ lastError: message.event.message });
          }
          return;
        default:
          return;
      }
    });

    return {
      rulesFile: null,
      profiles: [],
      lastError: null,
      setRules: (data) => connection.send({ type: 'setRules', data }),
      createProfile: (name, template) => connection.send({ type: 'createRuleProfile', name, template }),
      saveActiveAsProfile: (name) => connection.send({ type: 'saveActiveRulesAsProfile', name }),
      applyProfile: (name) => connection.send({ type: 'applyRuleProfile', name }),
      dismissError: () => set({ lastError: null }),
    };
  });
}
