import { describe, expect, it } from 'vitest';
import type { Rule, RulesFile } from '@/shared/api';
import {
  addDraftRule,
  createDraftRulesState,
  firstDraftRuleError,
  removeDraftRule,
  setDraftRuleFormError,
  syncDraftRulesState,
  toggleDraftRuleJsonMode,
  toRulesFile,
  updateDraftRule,
  updateDraftRuleActionJson,
} from './draftRules';

const sampleRulesFile: RulesFile = {
  rules: [
    {
      name: 'r1',
      match: { url: 'https://a.example.com/*' },
      action: { type: 'mock', status: 200, body: { ok: true } },
    },
    { name: 'r2', match: { url: 'https://b.example.com/*' }, action: { type: 'route', host: 'staging.example.com' } },
  ],
};

describe('draftRules (issue #282)', () => {
  it('assigns distinct stable IDs to initial rules and selects a queued pendingNewRule', () => {
    const queued: Rule = { name: 'queued', match: { url: '*' }, action: { type: 'breakpoint' } };
    const state = createDraftRulesState(sampleRulesFile, queued);

    expect(state.entries).toHaveLength(3);
    expect(new Set(state.entries.map((e) => e.id)).size).toBe(3);
    expect(state.selected).toBe(2);
    expect(state.entries[2]?.rule).toEqual(queued);
  });

  it('preserves a rule entry ID when renaming rule.name so the form never remounts and rolls back', () => {
    let state = createDraftRulesState(sampleRulesFile);
    const originalId = state.entries[0]!.id;

    state = toggleDraftRuleJsonMode(state, 0);
    state = updateDraftRuleActionJson(state, 0, '{"type": "mock", "body": {');
    expect(state.entries[0]?.jsonError).toMatch(/invalid json/i);

    // Renaming the rule while its JSON is invalid must keep the same entry ID
    // AND preserve the in-progress raw JSON text instead of rolling back.
    state = updateDraftRule(state, 0, { name: 'renamed-rule' });
    expect(state.entries[0]?.id).toBe(originalId);
    expect(state.entries[0]?.rule.name).toBe('renamed-rule');
    expect(state.entries[0]?.jsonText).toBe('{"type": "mock", "body": {');
    expect(state.entries[0]?.jsonError).toMatch(/invalid json/i);
  });

  it('gives two newly added rules distinct IDs even though both share the default name "new-rule"', () => {
    let state = createDraftRulesState({ rules: [] });
    state = addDraftRule(state);
    state = addDraftRule(state);

    expect(state.entries).toHaveLength(2);
    expect(state.entries[0]?.rule.name).toBe('new-rule');
    expect(state.entries[1]?.rule.name).toBe('new-rule');
    expect(state.entries[0]?.id).not.toBe(state.entries[1]?.id);
    expect(state.selected).toBe(1);
  });

  it('shifts selected index down when an earlier rule is removed so the open rule stays selected', () => {
    let state = createDraftRulesState(sampleRulesFile);
    state = addDraftRule(state); // index 2 selected
    expect(state.selected).toBe(2);

    // Removing index 0 shifts the selected rule from index 2 to index 1.
    state = removeDraftRule(state, 0);
    expect(state.selected).toBe(1);
    expect(state.entries[state.selected!]?.rule.name).toBe('new-rule');

    // Removing the selected rule itself closes the form (selected -> null).
    state = removeDraftRule(state, 1);
    expect(state.selected).toBeNull();
  });

  it('retains invalid raw JSON in Edit as JSON mode, blocks switching to Use form, and surfaces firstDraftRuleError', () => {
    let state = createDraftRulesState(sampleRulesFile);
    state = toggleDraftRuleJsonMode(state, 0);
    expect(state.entries[0]?.showJson).toBe(true);

    // Introduce a JSON syntax error in the response body.
    state = updateDraftRuleActionJson(state, 0, '{"type": "mock", "status": 200, "body": {"id": 1,}');
    expect(state.entries[0]?.jsonError).toMatch(/invalid json/i);
    expect(firstDraftRuleError(state)).toEqual({
      ruleIndex: 0,
      ruleName: 'r1',
      message: expect.stringMatching(/invalid json/i),
    });

    // Attempting to switch back to "Use form" while JSON is invalid is refused
    // so the user's edits are not silently discarded and rolled back.
    state = toggleDraftRuleJsonMode(state, 0);
    expect(state.entries[0]?.showJson).toBe(true);
    expect(state.entries[0]?.jsonText).toBe('{"type": "mock", "status": 200, "body": {"id": 1,}');

    // Fixing the JSON updates rule.action, clears the error, and allows switching back to "Use form".
    state = updateDraftRuleActionJson(state, 0, '{"type": "mock", "status": 201, "body": {"id": 1}}');
    expect(state.entries[0]?.jsonError).toBeNull();
    expect(firstDraftRuleError(state)).toBeNull();
    expect(toRulesFile(state).rules[0]?.action).toEqual({ type: 'mock', status: 201, body: { id: 1 } });

    state = toggleDraftRuleJsonMode(state, 0);
    expect(state.entries[0]?.showJson).toBe(false);
    expect(state.entries[0]?.jsonText).toBeNull();
  });

  it('surfaces structured-form errors (such as an invalid BodyRewrite.merge) via firstDraftRuleError and clears them on action reset', () => {
    let state = createDraftRulesState(sampleRulesFile);
    state = setDraftRuleFormError(
      state,
      0,
      'response.body.merge',
      'Invalid JSON — merge patch must be a valid JSON object.',
    );

    expect(firstDraftRuleError(state)).toEqual({
      ruleIndex: 0,
      ruleName: 'r1',
      message: 'Invalid JSON — merge patch must be a valid JSON object.',
    });

    // Switching action type resets formErrors.
    state = updateDraftRule(state, 0, { action: { type: 'breakpoint' } });
    expect(firstDraftRuleError(state)).toBeNull();
  });

  it('syncDraftRulesState assigns fresh IDs starting from nextId and clamps an out-of-bounds selection', () => {
    let state = createDraftRulesState(sampleRulesFile);
    state = { ...state, selected: 1 };
    const prevIds = state.entries.map((e) => e.id);

    const nextServerFile: RulesFile = { rules: [sampleRulesFile.rules[0]!] };
    const synced = syncDraftRulesState(state, nextServerFile);

    expect(synced.entries).toHaveLength(1);
    expect(synced.entries[0]?.id).toBeGreaterThan(Math.max(...prevIds));
    expect(synced.selected).toBeNull();
  });
});
