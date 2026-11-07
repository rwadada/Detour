import type { Rule, RulesFile } from '@/shared/api';
import { parseActionJson } from './actionFields';
import { blankRule } from './ruleSummary';

export interface DraftRuleEntry {
  /**
   * Stable local key for this rule across the life of the current draft
   * (issue #282). Keying `<RuleFields>` by this instead of `rule.name` fixes
   * two bugs:
   *  1. Editing `rule.name` no longer changes the React `key`, which previously
   *     unmounted `<ActionFields>` / `<JsonActionField>` on every keystroke and
   *     rolled back uncommitted local edits (raw JSON, body source, rewrite mode).
   *  2. Two rules with the same `rule.name` (e.g. clicking "+ Add rule" twice
   *     creates two `"new-rule"` entries) still get distinct keys, so switching
   *     between them resets the form instead of leaking one rule's edit buffer
   *     into the other.
   */
  id: number;
  rule: Rule;
  /** Whether this rule is currently open in "Edit as JSON" mode (`true`) or structured form mode (`false`). */
  showJson: boolean;
  /** Raw JSON text while `showJson` is `true` — kept here so collapsing ("Done"), switching rules, or renaming never drops an in-progress JSON edit. */
  jsonText: string | null;
  /** Validation error from `parseActionJson(jsonText)` when `showJson` is `true`, or `null` when valid. */
  jsonError: string | null;
  /** Per-field validation errors from structured form controls (e.g. a malformed `BodyRewrite.merge` JSON object). */
  formErrors: Record<string, string | null>;
}

export interface DraftRulesState {
  baseFile: RulesFile;
  entries: DraftRuleEntry[];
  selected: number | null;
  nextId: number;
}

function makeEntry(rule: Rule, id: number): DraftRuleEntry {
  return {
    id,
    rule,
    showJson: false,
    jsonText: null,
    jsonError: null,
    formErrors: {},
  };
}

/** Seeds the Rules editor's draft state from `rulesFile` and an optional queued `pendingNewRule`. */
export function createDraftRulesState(
  rulesFile: RulesFile | null,
  pendingNewRule: Rule | null = null,
  startId = 1,
): DraftRulesState {
  const baseFile = rulesFile ?? { rules: [] };
  const initialRules = pendingNewRule ? [...baseFile.rules, pendingNewRule] : baseFile.rules;
  let nextId = startId;
  const entries = initialRules.map((rule) => makeEntry(rule, nextId++));
  return {
    baseFile,
    entries,
    selected: pendingNewRule ? entries.length - 1 : null,
    nextId,
  };
}

/** Re-syncs the draft from a newly arrived server `rulesFile`, advancing IDs so mounted sub-forms reset cleanly. */
export function syncDraftRulesState(state: DraftRulesState, rulesFile: RulesFile): DraftRulesState {
  const rebuilt = createDraftRulesState(rulesFile, null, state.nextId);
  const selected = state.selected !== null && state.selected < rebuilt.entries.length ? state.selected : null;
  return { ...rebuilt, selected };
}

/** Serializes the current draft entries back into a `RulesFile` payload for `setRules`. */
export function toRulesFile(state: DraftRulesState): RulesFile {
  return {
    ...state.baseFile,
    rules: state.entries.map((entry) => entry.rule),
  };
}

/** Applies a partial `Rule` update to `entries[index]` while preserving its stable `id`. */
export function updateDraftRule(state: DraftRulesState, index: number, patch: Partial<Rule>): DraftRulesState {
  return {
    ...state,
    entries: state.entries.map((entry, i) => {
      if (i !== index) return entry;
      const nextRule = { ...entry.rule, ...patch };
      if (patch.action !== undefined) {
        return {
          ...entry,
          rule: nextRule,
          jsonText: entry.showJson ? JSON.stringify(patch.action, null, 2) : null,
          jsonError: null,
          formErrors: {},
        };
      }
      return { ...entry, rule: nextRule };
    }),
  };
}

/**
 * Updates `entries[index]` from raw edits in `JsonActionField` ("Edit as JSON",
 * issue #282). Even when `text` is temporarily invalid JSON, `jsonText` and
 * `jsonError` are stored in the draft entry so:
 *  - the editor marks the draft dirty immediately,
 *  - switching rules, clicking "Done", or editing `rule.name` never rolls the
 *    text back to the old `rule.action`, and
 *  - "Save to rules.json" stays blocked until the JSON error is fixed instead
 *    of silently saving the stale pre-edit `rule.action`.
 */
export function updateDraftRuleActionJson(state: DraftRulesState, index: number, text: string): DraftRulesState {
  const parsed = parseActionJson(text);
  return {
    ...state,
    entries: state.entries.map((entry, i) => {
      if (i !== index) return entry;
      if (parsed.ok) {
        return {
          ...entry,
          rule: { ...entry.rule, action: parsed.action },
          jsonText: text,
          jsonError: null,
        };
      }
      return {
        ...entry,
        jsonText: text,
        jsonError: parsed.error,
      };
    }),
  };
}

/**
 * Toggles `entries[index]` between structured form mode and "Edit as JSON".
 * Refuses to leave "Edit as JSON" while `jsonError` is present so clicking
 * "Use form" cannot silently discard invalid JSON and roll back `rule.action`.
 */
export function toggleDraftRuleJsonMode(state: DraftRulesState, index: number): DraftRulesState {
  return {
    ...state,
    entries: state.entries.map((entry, i) => {
      if (i !== index) return entry;
      if (entry.showJson) {
        if (entry.jsonError !== null) return entry;
        return { ...entry, showJson: false, jsonText: null, jsonError: null };
      }
      return {
        ...entry,
        showJson: true,
        jsonText: JSON.stringify(entry.rule.action, null, 2),
        jsonError: null,
        formErrors: {},
      };
    }),
  };
}

/** Records or clears a structured-form validation error (such as an invalid `BodyRewrite.merge` JSON object) on `entries[index]`. */
export function setDraftRuleFormError(
  state: DraftRulesState,
  index: number,
  fieldKey: string,
  error: string | null,
): DraftRulesState {
  return {
    ...state,
    entries: state.entries.map((entry, i) => {
      if (i !== index) return entry;
      if ((entry.formErrors[fieldKey] ?? null) === error) return entry;
      return {
        ...entry,
        formErrors: { ...entry.formErrors, [fieldKey]: error },
      };
    }),
  };
}

/** Appends a fresh `blankRule()` with a new unique `id` and selects it for editing. */
export function addDraftRule(state: DraftRulesState): DraftRulesState {
  const entry = makeEntry(blankRule(), state.nextId);
  return {
    ...state,
    entries: [...state.entries, entry],
    selected: state.entries.length,
    nextId: state.nextId + 1,
  };
}

/**
 * Deletes `entries[index]` and keeps `selected` pointing at the same remaining
 * rule when an earlier row is removed (issue #282 — previously deleting an
 * index `< selected` left `selected` unshifted, jumping the open editor to the
 * next rule).
 */
export function removeDraftRule(state: DraftRulesState, index: number): DraftRulesState {
  let selected = state.selected;
  if (selected === index) {
    selected = null;
  } else if (selected !== null && index < selected) {
    selected = selected - 1;
  }
  return {
    ...state,
    entries: state.entries.filter((_, i) => i !== index),
    selected,
  };
}

/** Returns the first rule in `state` with an unresolved JSON or form error, or `null` when every rule can be saved. */
export function firstDraftRuleError(
  state: DraftRulesState,
): { ruleIndex: number; ruleName: string; message: string } | null {
  for (const [index, entry] of state.entries.entries()) {
    const label = entry.rule.name || `#${index + 1}`;
    if (entry.jsonError) {
      return { ruleIndex: index, ruleName: label, message: entry.jsonError };
    }
    for (const message of Object.values(entry.formErrors)) {
      if (message) {
        return { ruleIndex: index, ruleName: label, message };
      }
    }
  }
  return null;
}
