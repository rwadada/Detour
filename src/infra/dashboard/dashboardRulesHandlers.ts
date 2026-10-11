import type { DashboardClientMessage, DashboardServerMessage } from '../../domain/dashboard/protocol';
import { SAMPLE_RULES_FILE } from '../../domain/rules/sample';
import { findRejectedScriptWrites } from '../../domain/rules/scriptGate';
import type { RulesFile } from '../../domain/rules/types';
import type { RuleProfileStore } from '../../usecase/ports/ruleProfileStore';
import type { RuleEngine } from '../../usecase/ruleEngine';
import { describeError } from './describeError';

/** What the rules-editing handlers need from the dashboard server (issue #207: no reaching into its closure). */
export interface RulesHandlerDeps {
  /** The session's rule engine right now — it can appear later, via `ensureRuleEngine`. */
  getRuleEngine: () => RuleEngine | undefined;
  /**
   * Returns the session's `ruleEngine`, provisioning one via `createRuleEngine` (issue #123) the first time
   * it's actually needed — see `DashboardServerOptions.createRuleEngine`'s own doc comment. Only
   * `applyRuleProfile` calls this: it's the one action reachable with no active rules file at all.
   */
  ensureRuleEngine: () => RuleEngine | undefined;
  ruleProfileStore: RuleProfileStore | undefined;
  broadcast: (message: DashboardServerMessage) => void;
  broadcastError: (errorKind: string, message: string) => void;
  ruleProfilesMessage: () => DashboardServerMessage;
}

type MessageOf<T extends DashboardClientMessage['type']> = Extract<DashboardClientMessage, { type: T }>;

export interface RulesHandlers {
  setRules: (message: MessageOf<'setRules'>) => void;
  createRuleProfile: (message: MessageOf<'createRuleProfile'>) => void;
  saveActiveRulesAsProfile: (message: MessageOf<'saveActiveRulesAsProfile'>) => void;
  applyRuleProfile: (message: MessageOf<'applyRuleProfile'>) => void;
}

/**
 * Rules editing/profiles (issue #19) are handled directly rather than via the event bus, since they need
 * synchronous validation and per-attempt error feedback that a fire-and-forget event emit can't give.
 */
export function createRulesHandlers(deps: RulesHandlerDeps): RulesHandlers {
  const { broadcast, broadcastError, ruleProfilesMessage } = deps;

  return {
    setRules(message) {
      const ruleEngine = deps.getRuleEngine();
      if (!ruleEngine) return broadcastError('RULES_WRITE_ERROR', 'No rules file is configured for this session.');
      // Issue #161: refuse a `setRules` write that adds a brand-new `script` rule or changes an existing one's
      // `path`, regardless of whether `--allow-scripts` is on — this closes the network-reachable half of the
      // `setRules` → `script` → `require()` chain without touching the read side (a `script` rule already in
      // rules.json keeps running, subject to `--allow-scripts`, however it got there). Checked before the `try`
      // below since this is a validation failure, not a write failure — nothing has been written yet either way.
      const scriptViolations = findRejectedScriptWrites(ruleEngine.getRules(), message.data.rules);
      if (scriptViolations.length > 0) {
        return broadcastError('RULES_WRITE_ERROR', scriptViolations.join('; '));
      }
      try {
        // No `activeProfile` — clears `$activeProfile` on the written file even if `message.data` (the editor's
        // own draft, synced from an earlier `rules` broadcast) still happened to carry one along. Editing and
        // saving makes this a different, unnamed ruleset — see `RulesFile.$activeProfile`'s doc comment.
        ruleEngine.write(message.data.rules);
      } catch (err) {
        broadcastError('RULES_WRITE_ERROR', describeError(err));
      }
    },

    createRuleProfile(message) {
      const { ruleProfileStore } = deps;
      if (!ruleProfileStore) return broadcastError('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
      try {
        const data: RulesFile =
          message.template === 'sample' ? (JSON.parse(SAMPLE_RULES_FILE) as RulesFile) : { rules: [] };
        ruleProfileStore.write(message.name, data);
        broadcast(ruleProfilesMessage());
      } catch (err) {
        broadcastError('RULE_PROFILE_ERROR', describeError(err));
      }
    },

    saveActiveRulesAsProfile(message) {
      const { ruleProfileStore } = deps;
      const ruleEngine = deps.getRuleEngine();
      if (!ruleEngine || !ruleProfileStore) {
        return broadcastError('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
      }
      try {
        const rules = [...ruleEngine.getRules()];
        ruleProfileStore.write(message.name, { rules });
        // The active rules.json's *content* doesn't change here — only a new profile file, snapshotting it, does
        // — but that content now does correspond to a named profile where a moment ago it may not have, so this
        // marks it as such (see `RulesFile.$activeProfile`).
        ruleEngine.write(rules, { activeProfile: message.name });
        broadcast(ruleProfilesMessage());
      } catch (err) {
        broadcastError('RULE_PROFILE_ERROR', describeError(err));
      }
    },

    applyRuleProfile(message) {
      const { ruleProfileStore } = deps;
      // Checked *before* `ensureRuleEngine()` — that call can have the real side effect of writing a rules file
      // and starting a watcher on it; nothing about this request can succeed without `ruleProfileStore`
      // regardless, so there's no reason to provision an engine only to then reject it.
      if (!ruleProfileStore) return broadcastError('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
      try {
        // Inside the `try`, not before it: `ensureRuleEngine()` can throw (a `createRuleEngine` factory failing
        // to write/load its rules file) just as readily as `engine.write()`/`ruleProfileStore.read()` below can —
        // leaving it uncaught would drop the message with no `RULE_PROFILE_ERROR`, leaving the dashboard looking
        // stuck rather than told why.
        const engine = deps.ensureRuleEngine();
        if (!engine) return broadcastError('RULE_PROFILE_ERROR', 'Rule profiles are unavailable.');
        const profileRules = ruleProfileStore.read(message.name).rules;
        // Same reasoning as `setRules`'s own check above (issue #161): `applyRuleProfile` is an equally
        // network-reachable way to change what's active, so it has to be gated the same way — a saved profile can
        // carry a `script` rule from a time it was legitimately active. Applying it back must not resurrect a
        // `script` rule (or change its path) that isn't already active right now, exactly as `setRules` can't.
        const scriptViolations = findRejectedScriptWrites(engine.getRules(), profileRules);
        if (scriptViolations.length > 0) {
          return broadcastError('RULE_PROFILE_ERROR', scriptViolations.join('; '));
        }
        engine.write(profileRules, { activeProfile: message.name });
      } catch (err) {
        broadcastError('RULE_PROFILE_ERROR', describeError(err));
      }
    },
  };
}
