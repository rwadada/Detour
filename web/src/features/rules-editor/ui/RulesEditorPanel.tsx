import { json } from '@codemirror/lang-json';
import CodeMirror from '@uiw/react-codemirror';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useRuleStore } from '@/entities/rule';
import { useTheme } from '@/shared/lib/theme';
import { cn } from '@/shared/lib/utils';
import type { Rule, RulesFile } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import { blankRule, describeMatch, parseMethodInput } from '../model/ruleSummary';

/**
 * The Rules editor's body (issue #19), rendered inside a `Dialog` by
 * `RulesEditorButton`. Edits are staged in local `draft` state and only
 * sent to the server (`setRules`) when "Save" is clicked — the file itself,
 * and the traffic it's actively matching, are untouched until then.
 *
 * `name`/`enabled`/`method`/`url` are true form fields; a rule's `action`
 * (and `urlRegex` matches, which this form doesn't expose) are edited as
 * JSON — the five action types (`mock`/`route`/`rewrite`/`breakpoint`/
 * `script`) have different enough shapes that a dedicated sub-form per type
 * is future work (see PR description) rather than in scope here.
 */
export function RulesEditorPanel() {
  const rulesFile = useRuleStore((s) => s.rulesFile);
  const setRules = useRuleStore((s) => s.setRules);
  const [draft, setDraft] = useState<RulesFile>(rulesFile ?? { rules: [] });
  const [syncedFrom, setSyncedFrom] = useState(rulesFile);
  const [selected, setSelected] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  // Re-syncs the draft from the server whenever a fresh `rulesFile` arrives
  // while nothing is unsaved — covers both the initial load (draft starts
  // empty before the first `rules` message) and an external reload (e.g.
  // someone hand-edited rules.json) while the panel sits idle. A dirty
  // draft is left alone so in-progress edits are never silently discarded.
  // Adjusted during render (react.dev's "you might not need an effect"
  // pattern) rather than in a `useEffect`, so a genuinely new `rulesFile`
  // is reflected in the same render instead of one tick later.
  if (rulesFile !== syncedFrom && !dirty && rulesFile) {
    setSyncedFrom(rulesFile);
    setDraft(rulesFile);
  }

  if (!rulesFile) {
    return (
      <p className="text-sm text-[var(--muted)]">
        No rules file is configured for this session. Start{' '}
        <code className="font-mono-ui">detour start --rules rules.json</code> (or let it auto-detect a{' '}
        <code className="font-mono-ui">rules.json</code> in the working directory) to enable the Rules editor.
      </p>
    );
  }

  const updateRule = (index: number, patch: Partial<Rule>) => {
    setDraft((d) => ({ ...d, rules: d.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) }));
    setDirty(true);
  };

  const addRule = () => {
    setDraft((d) => ({ ...d, rules: [...d.rules, blankRule()] }));
    setSelected(draft.rules.length);
    setDirty(true);
  };

  const removeRule = (index: number) => {
    setDraft((d) => ({ ...d, rules: d.rules.filter((_, i) => i !== index) }));
    if (selected === index) setSelected(null);
    setDirty(true);
  };

  const discard = () => {
    setDraft(rulesFile);
    setSelected(null);
    setDirty(false);
  };

  const save = () => {
    setRules(draft);
    setDirty(false);
  };

  const editing = selected !== null ? draft.rules[selected] : undefined;

  return (
    <div className="flex h-[60vh] flex-col gap-3">
      <div className="flex-1 overflow-auto rounded-md border border-[var(--border)]">
        {draft.rules.length === 0 ? (
          <p className="p-3 text-sm text-[var(--muted)]">No rules yet.</p>
        ) : (
          <ul>
            {draft.rules.map((rule, index) => (
              <li
                key={`${rule.name}-${index}`}
                className={cn(
                  'flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-sm last:border-b-0',
                  selected === index && 'bg-[var(--row-selected)]',
                )}
              >
                <input
                  type="checkbox"
                  checked={rule.enabled ?? true}
                  onChange={(e) => updateRule(index, { enabled: e.target.checked })}
                  title={rule.enabled === false ? 'Disabled' : 'Enabled'}
                />
                <button type="button" className="flex-1 truncate text-left" onClick={() => setSelected(index)}>
                  <span className="font-medium">{rule.name}</span>{' '}
                  <span className="text-[var(--muted)]">— {describeMatch(rule)}</span>{' '}
                  <span className="text-[10px] uppercase text-[var(--accent)]">{rule.action.type}</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeRule(index)}
                  className="rounded p-1 text-[var(--muted)] hover:bg-[var(--row-hover)] hover:text-[var(--status-5xx)]"
                  title="Delete rule"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Button variant="ghost" onClick={addRule} className="w-fit gap-1">
        <Plus className="h-3.5 w-3.5" /> Add rule
      </Button>

      {editing && selected !== null && (
        <RuleFields
          rule={editing}
          onChange={(patch) => updateRule(selected, patch)}
          onClose={() => setSelected(null)}
        />
      )}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
        <Button variant="ghost" onClick={discard} disabled={!dirty}>
          Discard changes
        </Button>
        <Button onClick={save} disabled={!dirty}>
          Save to rules.json
        </Button>
      </div>
    </div>
  );
}

function RuleFields({
  rule,
  onChange,
  onClose,
}: {
  rule: Rule;
  onChange: (patch: Partial<Rule>) => void;
  onClose: () => void;
}) {
  const dark = useTheme() === 'dark';
  const [actionText, setActionText] = useState(() => JSON.stringify(rule.action, null, 2));
  const [actionError, setActionError] = useState<string | null>(null);
  const [seededFor, setSeededFor] = useState(rule.name);

  // Re-seeds the action textarea when a different rule is opened for
  // editing — not on every keystroke of the rule currently open (hence
  // keying off `rule.name` rather than `rule`/`rule.action`, and adjusting
  // during render rather than in a `useEffect` — see the draft-sync comment
  // above for why).
  if (rule.name !== seededFor) {
    setSeededFor(rule.name);
    setActionText(JSON.stringify(rule.action, null, 2));
    setActionError(null);
  }

  const commitAction = (text: string) => {
    setActionText(text);
    try {
      const parsed = JSON.parse(text);
      setActionError(null);
      onChange({ action: parsed });
    } catch {
      setActionError('Invalid JSON — not saved to the draft yet.');
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--muted)]">Editing rule</span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
      <label className="text-xs text-[var(--muted)]">
        Name
        <Input value={rule.name} onChange={(e) => onChange({ name: e.target.value })} className="mt-0.5" />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-[var(--muted)]">
          Method (comma-separated, blank = any)
          <Input
            value={Array.isArray(rule.match.method) ? rule.match.method.join(',') : (rule.match.method ?? '')}
            onChange={(e) => onChange({ match: { ...rule.match, method: parseMethodInput(e.target.value) } })}
            className="mt-0.5"
          />
        </label>
        <label className="text-xs text-[var(--muted)]">
          URL pattern (<code className="font-mono-ui">*</code>/<code className="font-mono-ui">?</code> wildcards)
          <Input
            value={rule.match.url ?? ''}
            onChange={(e) => onChange({ match: { ...rule.match, url: e.target.value } })}
            className="mt-0.5"
          />
        </label>
      </div>
      <div className="text-xs text-[var(--muted)]">
        Action (JSON — <code className="font-mono-ui">type</code>: <code className="font-mono-ui">mock</code> /{' '}
        <code className="font-mono-ui">route</code> / <code className="font-mono-ui">rewrite</code> /{' '}
        <code className="font-mono-ui">breakpoint</code> / <code className="font-mono-ui">script</code>)
      </div>
      <CodeMirror
        value={actionText}
        extensions={[json()]}
        theme={dark ? 'dark' : 'light'}
        basicSetup={{ lineNumbers: true, foldGutter: true }}
        onChange={commitAction}
        className="h-40 rounded border border-[var(--border)] text-xs"
      />
      {actionError && <p className="text-xs text-[var(--status-5xx)]">{actionError}</p>}
    </div>
  );
}
