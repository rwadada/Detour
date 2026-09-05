import { json } from '@codemirror/lang-json';
import CodeMirror from '@uiw/react-codemirror';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useRuleStore } from '@/entities/rule';
import { useTheme } from '@/shared/lib/theme';
import { cn } from '@/shared/lib/utils';
import type { Rule, RuleAction, RulesFile } from '@/shared/api';
import { Button, Input, Select } from '@/shared/ui';
import { blankAction } from '../model/actionFields';
import { blankRule, describeMatch, parseMethodInput } from '../model/ruleSummary';
import { ActionFields } from './ActionFields';

const ACTION_TYPES: RuleAction['type'][] = ['mock', 'route', 'rewrite', 'breakpoint', 'script'];

/**
 * The Rules editor's body (issue #19), rendered inside a `Dialog` by
 * `RulesEditorButton`. Edits are staged in local `draft` state and only
 * sent to the server (`setRules`) when "Save" is clicked — the file itself,
 * and the traffic it's actively matching, are untouched until then.
 *
 * `name`/`enabled`/`method`/`url` are true form fields. A rule's `action`
 * gets a dedicated structured form per type via `ActionFields` (issue #9's
 * follow-up — non-engineers shouldn't have to hand-write JSON for the
 * common cases) with a raw-JSON view still available behind an "Edit as
 * JSON" toggle for anything the form doesn't cover (a `urlRegex` match,
 * which this form doesn't expose either, is the other main example).
 */
export function RulesEditorPanel() {
  const rulesFile = useRuleStore((s) => s.rulesFile);
  const setRules = useRuleStore((s) => s.setRules);
  const dirty = useRuleStore((s) => s.dirtyDraft);
  const setDirty = useRuleStore((s) => s.setDirtyDraft);
  const [draft, setDraft] = useState<RulesFile>(rulesFile ?? { rules: [] });
  const [syncedFrom, setSyncedFrom] = useState(rulesFile);
  const [selected, setSelected] = useState<number | null>(null);

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
      {/* Capped instead of flex-1 while a rule's being edited: the edit form below can run long
          (rewrite's request+response sections, breakpoint's notes, …) and needs the room more than
          this list does once something's selected — see the `editing ? ... : 'flex-1'` split below
          giving that room back to the form, wrapped in its own scroll region. Without this split,
          this list ate the whole flex-1 share and pushed the form (and its "Done" button) out past
          the visible area with no independent way to scroll back up to it. */}
      <div
        className={cn(
          'overflow-auto rounded-md border border-[var(--border)]',
          editing ? 'max-h-32 shrink-0' : 'flex-1',
        )}
      >
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

      <Button variant="ghost" onClick={addRule} className="w-fit shrink-0 gap-1">
        <Plus className="h-3.5 w-3.5" /> Add rule
      </Button>

      {editing && selected !== null && (
        <div className="min-h-0 flex-1 overflow-auto">
          <RuleFields
            rule={editing}
            onChange={(patch) => updateRule(selected, patch)}
            onClose={() => setSelected(null)}
          />
        </div>
      )}

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
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
  const [showJson, setShowJson] = useState(false);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-3">
      {/* Sticky against the scroll region RulesEditorPanel wraps this form in — a long form (rewrite's
          request+response sections, in particular) can scroll well past this point, and "Done" needs
          to stay reachable without scrolling back up to find it. The negative margin/matching padding
          extends the sticky bar's background across the parent's own padding, so content scrolling
          underneath doesn't show through at the edges. */}
      <div className="sticky top-0 z-10 -mx-3 -mt-3 flex items-center justify-between bg-[var(--panel)] px-3 py-3">
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

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
          Action type
          <Select
            value={rule.action.type}
            onChange={(e) => onChange({ action: blankAction(e.target.value as RuleAction['type']) })}
          >
            {ACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </label>
        <button
          type="button"
          onClick={() => setShowJson((v) => !v)}
          className="text-xs text-[var(--muted)] underline decoration-dotted hover:text-[var(--foreground)]"
        >
          {showJson ? 'Use form' : 'Edit as JSON'}
        </button>
      </div>

      {showJson ? (
        <JsonActionField key={rule.name} action={rule.action} onChange={(action) => onChange({ action })} />
      ) : (
        <ActionFields key={rule.name} action={rule.action} onChange={(action) => onChange({ action })} />
      )}
    </div>
  );
}

/** The raw-JSON fallback for a rule's `action` — the same CodeMirror editor the Rules editor originally shipped with, kept as an escape hatch for anything `ActionFields` doesn't cover. */
function JsonActionField({ action, onChange }: { action: RuleAction; onChange: (action: RuleAction) => void }) {
  const dark = useTheme() === 'dark';
  const [text, setText] = useState(() => JSON.stringify(action, null, 2));
  const [error, setError] = useState<string | null>(null);

  const commit = (nextText: string) => {
    setText(nextText);
    try {
      const parsed = JSON.parse(nextText);
      setError(null);
      onChange(parsed);
    } catch {
      setError('Invalid JSON — not saved to the draft yet.');
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <CodeMirror
        value={text}
        extensions={[json()]}
        theme={dark ? 'dark' : 'light'}
        basicSetup={{ lineNumbers: true, foldGutter: true }}
        onChange={commit}
        className="h-40 rounded border border-[var(--border)] text-xs"
      />
      {error && <p className="text-xs text-[var(--status-5xx)]">{error}</p>}
    </div>
  );
}
