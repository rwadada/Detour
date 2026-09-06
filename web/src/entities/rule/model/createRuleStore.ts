import { create } from 'zustand';
import type { DashboardConnection, RuleProfileSummary, RulesFile } from '@/shared/api';

export interface RuleState {
  /** The currently active rules.json contents, or `null` if this session has no rules file configured, or the initial `rules` message hasn't arrived yet. */
  rulesFile: RulesFile | null;
  /**
   * `Date.now()` when `rulesFile` was last (re)set — updated on *every*
   * incoming `rules` message, even one whose content happens to be
   * identical to what was already there (applying a profile that's already
   * active, say). Lets a consumer with its own "I dispatched something at
   * time T" marker (`RuleProfilesControl`'s `pending`) require a
   * genuinely-arrived-after-dispatch update before treating the *content*
   * matching its target as this request's own success, rather than a
   * coincidence that was already true before it was ever sent.
   */
  rulesFileAt: number | null;
  /** Saved rule profiles (issue #19's Rules Profiles), available to apply or overwrite. */
  profiles: RuleProfileSummary[];
  /** `Date.now()` when `profiles` was last (re)set — mirrors `rulesFileAt`, for the same reason, against `ruleProfiles` messages instead. */
  profilesAt: number | null;
  /** The most recent `RULES_WRITE_ERROR`/`RULE_PROFILE_ERROR` message from the server, if any hasn't been dismissed yet. */
  lastError: string | null;
  /**
   * `Date.now()` when `lastError` was last set — `null` exactly when
   * `lastError` is. Lets a consumer with its own "I dispatched something at
   * time T" marker (`RuleProfilesControl`'s `pending`) tell an error that's
   * actually about *its* request apart from one already sitting here from
   * an earlier, unrelated action (this is one shared field for every
   * `RULES_WRITE_ERROR`/`RULE_PROFILE_ERROR` this session sees, including
   * ones from other controls, or even another connected browser tab) by
   * requiring the timestamp to be at least as new as its own dispatch.
   */
  lastErrorAt: number | null;
  /** Saves edits to the active rules.json (Rules editor). */
  setRules: (data: RulesFile) => void;
  /** Creates a new saved profile from a template. */
  createProfile: (name: string, template: 'blank' | 'sample') => void;
  /** Saves the currently active rules as a named profile (creating or overwriting it). */
  saveActiveAsProfile: (name: string) => void;
  /** Loads a saved profile's rules into the active rules.json. */
  applyProfile: (name: string) => void;
  dismissError: () => void;
  /**
   * Whether the Rules editor (`RulesEditorPanel`) has unsaved local edits.
   * Lifted up from the editor itself (rather than kept as its own local
   * state) so `RuleProfilesControl` and `RulesEditorButton` can guard
   * against silently discarding/being discarded by it: applying a profile
   * while a dirty draft sits open would otherwise get quietly clobbered by
   * a later "Save to rules.json" (the editor's own sync-from-server guard
   * intentionally leaves a dirty draft alone), and closing the editor would
   * otherwise drop in-progress edits with no confirmation.
   */
  dirtyDraft: boolean;
  setDirtyDraft: (dirty: boolean) => void;
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
          set({ rulesFile: message.data, rulesFileAt: Date.now() });
          return;
        case 'ruleProfiles':
          set({ profiles: message.profiles, profilesAt: Date.now() });
          return;
        case 'error':
          if (message.event.errorKind === 'RULES_WRITE_ERROR' || message.event.errorKind === 'RULE_PROFILE_ERROR') {
            set({ lastError: message.event.message, lastErrorAt: Date.now() });
          }
          return;
        default:
          return;
      }
    });

    return {
      rulesFile: null,
      rulesFileAt: null,
      profiles: [],
      profilesAt: null,
      lastError: null,
      lastErrorAt: null,
      setRules: (data) => connection.send({ type: 'setRules', data }),
      createProfile: (name, template) => connection.send({ type: 'createRuleProfile', name, template }),
      saveActiveAsProfile: (name) => connection.send({ type: 'saveActiveRulesAsProfile', name }),
      applyProfile: (name) => connection.send({ type: 'applyRuleProfile', name }),
      dismissError: () => set({ lastError: null, lastErrorAt: null }),
      dirtyDraft: false,
      setDirtyDraft: (dirty) => set({ dirtyDraft: dirty }),
    };
  });
}
