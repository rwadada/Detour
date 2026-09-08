import { json } from '@codemirror/lang-json';
import CodeMirror from '@uiw/react-codemirror';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRuleStore } from '@/entities/rule';
import { useTheme } from '@/shared/lib/theme';
import { cn } from '@/shared/lib/utils';
import type { Rule, RuleAction, RulesFile } from '@/shared/api';
import { Button, Input, Select } from '@/shared/ui';
import { blankAction } from '../model/actionFields';
import { blankRule, describeMatch, parseMethodInput } from '../model/ruleSummary';
import { ActionFields } from './ActionFields';

const ACTION_TYPES: RuleAction['type'][] = ['mock', 'route', 'rewrite', 'breakpoint', 'script'];

/** How long `save()` waits for the server's `rules`/`error` broadcast before giving up — WS delivery on a live connection is effectively instant, so this is just a bailout for the unusual case (a dropped connection, say) where neither ever arrives and the dialog would otherwise be stuck showing "Saving…" forever. Mirrors `RuleProfilesControl`'s own `PENDING_CONFIRMATION_TIMEOUT_MS` for the same reason. */
const SAVE_TIMEOUT_MS = 5000;

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
  const rulesFileAt = useRuleStore((s) => s.rulesFileAt);
  const setRules = useRuleStore((s) => s.setRules);
  const dirty = useRuleStore((s) => s.dirtyDraft);
  const setDirty = useRuleStore((s) => s.setDirtyDraft);
  const lastError = useRuleStore((s) => s.lastError);
  const lastErrorAt = useRuleStore((s) => s.lastErrorAt);
  const dismissError = useRuleStore((s) => s.dismissError);
  const pendingNewRule = useRuleStore((s) => s.pendingNewRule);
  const clearPendingNewRule = useRuleStore((s) => s.clearPendingNewRule);
  // Seeds a queued rule (`RuleState.pendingNewRule`'s own doc comment)
  // straight into the initial draft, already selected — read once, here,
  // rather than in an effect, since this component remounts fresh every
  // time `Dialog` opens it (`RulesEditorButton`'s `open` toggles whether
  // `<RulesEditorPanel />` renders at all), so "on mount" and "the moment
  // there's a queued rule to show" are the same event for this component.
  const [draft, setDraft] = useState<RulesFile>(() => {
    const base = rulesFile ?? { rules: [] };
    return pendingNewRule ? { ...base, rules: [...base.rules, pendingNewRule] } : base;
  });
  const [syncedFrom, setSyncedFrom] = useState(rulesFile);
  const [selected, setSelected] = useState<number | null>(() => (pendingNewRule ? draft.rules.length - 1 : null));
  // `Date.now()` when `save()` last sent a `setRules` — `null` once that
  // save has resolved (either way) or nothing's been sent yet. See the
  // effect below: `setRules` is a fire-and-forget WS message with no
  // per-request ack, so this is what ties a later `rules`/`error` message
  // back to *this* save rather than an unrelated one from earlier or from
  // another connected tab.
  const [pendingSaveAt, setPendingSaveAt] = useState<number | null>(null);
  // The server's rejection of the most recent save (e.g. failed
  // validation), if it hasn't been superseded by a later save attempt yet.
  // Previously `save()` cleared `dirty` unconditionally the instant it was
  // clicked, so a rejected save (bad rule data, a duplicate name, …) looked
  // exactly like a successful one — the draft was marked clean and the
  // dialog gave no indication anything was wrong, even though rules.json on
  // disk never changed.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Bumped by every draft edit (`updateRule`/`addRule`/`removeRule`) —
  // `save()` snapshots the current value into `savingVersion` below.
  // Together they're what tells the resolving effect apart a save that
  // succeeded with nothing left unsaved from one whose success arrived
  // *after* the user had already made more edits: naively clearing `dirty`
  // on any success would otherwise silently drop those newer edits'
  // "there's something unsaved" status the moment the *earlier* save's ack
  // showed up.
  const [draftVersion, setDraftVersion] = useState(0);
  // `draftVersion` at the moment `save()` last dispatched — `null` when no
  // save is in flight. `dirty` only actually clears once the resolving
  // effect sees this still matches the (possibly since-advanced)
  // `draftVersion`.
  const [savingVersion, setSavingVersion] = useState<number | null>(null);
  // The exact `rules` `save()` last sent — `null` when no save is in
  // flight. `rulesFileAt` alone isn't enough to tell *this* save's ack
  // apart from a same-timing-window `rules` broadcast for something else
  // entirely (another connected tab's own edit, a profile switch, someone
  // hand-editing rules.json — `createRuleStore`'s own docs note `rules`
  // is shared across all of those): only a `rulesFile` whose `rules`
  // actually match what was sent is genuinely this save landing, mirroring
  // how `RuleProfilesControl` requires content, not just freshness, before
  // treating its own fire-and-forget commands as resolved.
  const [sentRules, setSentRules] = useState<Rule[] | null>(null);

  // Consumes `pendingNewRule` exactly once, right after the initial draft
  // above already baked it in — an effect (not read during render) since
  // clearing it is a genuine side effect on shared, cross-widget state, not
  // something derivable from this component's own props/state. Marks the
  // draft dirty too, so Save/Discard reflect there's really something
  // unsaved and the resync-from-server guard above leaves it alone.
  useEffect(() => {
    if (!pendingNewRule) return;
    clearPendingNewRule();
    setDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount to consume whatever pendingNewRule (if any) the initial draft above already captured; re-running if it somehow changed later would re-append a rule already baked into draft
  }, []);

  // Resolves a save dispatched by `save()` below against whichever of
  // `lastError`/`rulesFile` actually changes first, the same way
  // `RuleProfilesControl` resolves its own fire-and-forget WS commands
  // (see that component's matching effect for the fuller rationale): a
  // `RULES_WRITE_ERROR` no older than `pendingSaveAt` means this specific
  // save was rejected, so the draft stays dirty and the rejection reason is
  // shown instead of being silently swallowed; a `rulesFile` update no
  // older than `pendingSaveAt` *and* whose `rules` match `sentRules` means
  // this save specifically landed (see that field's own doc comment on why
  // freshness alone can't tell that apart from an unrelated broadcast).
  // `dirty` only actually clears then if `draftVersion` still matches what
  // was saved — otherwise the user made more edits while this save was in
  // flight, and clearing it would silently mark those newer, still-unsaved
  // edits as saved too.
  useEffect(() => {
    if (pendingSaveAt === null) return;
    if (lastError !== null && lastErrorAt !== null && lastErrorAt >= pendingSaveAt) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSaveError(lastError);
      dismissError();
      setPendingSaveAt(null);
      setSavingVersion(null);
      setSentRules(null);
      return;
    }
    const landed =
      rulesFileAt !== null &&
      rulesFileAt >= pendingSaveAt &&
      JSON.stringify(rulesFile?.rules) === JSON.stringify(sentRules);
    if (landed) {
      if (savingVersion === draftVersion) setDirty(false);
      setPendingSaveAt(null);
      setSavingVersion(null);
      setSentRules(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setDirty/dismissError are stable-enough store actions, not reactive values this effect should re-run for
  }, [pendingSaveAt, lastError, lastErrorAt, rulesFile, rulesFileAt, savingVersion, draftVersion, sentRules]);

  // Bails out of a save that never resolved either way — see
  // `SAVE_TIMEOUT_MS`'s own doc comment. Surfaces it as a `saveError`
  // (rather than silently unsticking "Saving…") since something genuinely
  // did go wrong: the draft's own dirty status was already left untouched
  // by the effect above, exactly as if the rejection had a message.
  useEffect(() => {
    if (pendingSaveAt === null) return;
    const timer = setTimeout(() => {
      setSaveError('No response from the server — the connection may have dropped. Try saving again.');
      setPendingSaveAt(null);
      setSavingVersion(null);
      setSentRules(null);
    }, SAVE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingSaveAt]);

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
    setSaveError(null);
    setDraftVersion((v) => v + 1);
  };

  const addRule = () => {
    setDraft((d) => ({ ...d, rules: [...d.rules, blankRule()] }));
    setSelected(draft.rules.length);
    setDirty(true);
    setSaveError(null);
    setDraftVersion((v) => v + 1);
  };

  const removeRule = (index: number) => {
    setDraft((d) => ({ ...d, rules: d.rules.filter((_, i) => i !== index) }));
    if (selected === index) setSelected(null);
    setDirty(true);
    setSaveError(null);
    setDraftVersion((v) => v + 1);
  };

  const discard = () => {
    setDraft(rulesFile);
    setSelected(null);
    setDirty(false);
    setSaveError(null);
    setPendingSaveAt(null);
    setSavingVersion(null);
    setSentRules(null);
  };

  const save = () => {
    setSaveError(null);
    setPendingSaveAt(Date.now());
    setSavingVersion(draftVersion);
    setSentRules(draft.rules);
    setRules(draft);
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
        {saveError && <p className="mr-auto text-xs text-[var(--status-5xx)]">Not saved — {saveError}</p>}
        <Button variant="ghost" onClick={discard} disabled={!dirty || pendingSaveAt !== null}>
          Discard changes
        </Button>
        <Button onClick={save} disabled={!dirty || pendingSaveAt !== null}>
          {pendingSaveAt !== null ? 'Saving…' : 'Save to rules.json'}
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
