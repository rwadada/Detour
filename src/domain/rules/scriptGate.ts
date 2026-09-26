/**
 * Guards around `script` rules (issue #161): unlike `unreachableRules.ts`'s
 * warnings, these two functions gate actual behavior — which `script` rules
 * run at all, and which ones a `setRules` write may add/modify — not just
 * flag something for a human to notice.
 */

import type { Rule, ScriptAction } from './types';

export interface ScriptGateWarning {
  ruleName: string;
  ruleIndex: number;
  /** Pre-formatted for direct printing/display — mirrors `UnreachableRuleWarning.message`. */
  message: string;
}

/**
 * Every `script` rule in `rules`, when `allowScripts` is off (issue #161's
 * `--allow-scripts` opt-in) — surfaced at startup/reload (CLI + dashboard)
 * so a rules.json full of scripts that silently never run isn't a mystery.
 * Doesn't itself skip anything; `infra/proxy/scriptModuleLoader.ts`'s
 * `tryLoadScriptModule` is what actually refuses to load the module.
 */
export function findDisabledScriptWarnings(rules: readonly Rule[], allowScripts: boolean): ScriptGateWarning[] {
  if (allowScripts) return [];
  const warnings: ScriptGateWarning[] = [];
  rules.forEach((rule, index) => {
    if (rule.action.type !== 'script') return;
    warnings.push({
      ruleName: rule.name,
      ruleIndex: index,
      message: `rule "${rule.name}" (index ${index}): \`script\` actions are disabled — pass --allow-scripts to run it, or remove the rule.`,
    });
  });
  return warnings;
}

/**
 * Rejects a dashboard-submitted `setRules` write that adds a brand-new
 * `script` rule or changes an existing one's `path` (issue #161) — closes
 * the network-reachable half of the `setRules` → `script` → `require()`
 * chain without touching the read side: a `script` rule already on disk
 * keeps running exactly as before (subject to `--allow-scripts`), since
 * only a *write* through this specific path is refused. Editing rules.json
 * directly (a text editor, or `detour test`/`detour record`'s own file
 * writes) is untouched — this only ever runs against a `setRules` payload.
 *
 * Matches rules by `name`: rules.json has no other stable identity across a
 * write, so a bare rename of an untouched `script` rule reads the same as
 * "remove the old one, add a new one" and is (conservatively) rejected too.
 * That's the safe direction for a check whose whole point is refusing an
 * unrecognized `script` action — the fix (renaming back, or editing
 * rules.json by hand instead) costs far less than the alternative of a
 * rename accidentally smuggling through a path change.
 */
export function findRejectedScriptWrites(existing: readonly Rule[], next: readonly Rule[]): string[] {
  const existingScriptPathByName = new Map<string, string>();
  for (const rule of existing) {
    if (rule.action.type === 'script') existingScriptPathByName.set(rule.name, (rule.action as ScriptAction).path);
  }

  const violations: string[] = [];
  for (const rule of next) {
    if (rule.action.type !== 'script') continue;
    const priorPath = existingScriptPathByName.get(rule.name);
    if (priorPath === undefined) {
      violations.push(
        `rule "${rule.name}": adding a new \`script\` rule from the dashboard is not allowed — add it to rules.json directly instead.`,
      );
    } else if (priorPath !== rule.action.path) {
      violations.push(
        `rule "${rule.name}": changing a \`script\` rule's path from the dashboard is not allowed — edit rules.json directly instead.`,
      );
    }
  }
  return violations;
}
