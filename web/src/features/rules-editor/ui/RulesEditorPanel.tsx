import { json } from '@codemirror/lang-json';
import CodeMirror from '@uiw/react-codemirror';
import { AlertTriangle, Plus, ShieldOff, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRuleStore } from '@/entities/rule';
import type { Rule, RuleAction, ScriptGateWarning, UnreachableRuleWarning } from '@/shared/api';
import { useTheme } from '@/shared/lib/theme';
import { cn } from '@/shared/lib/utils';
import { Button, Input, Select } from '@/shared/ui';
import { ACTION_TYPES, blankAction } from '../model/actionFields';
import {
  type DraftRuleEntry,
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
} from '../model/draftRules';
import { describeMatch, methodToEditableText, parseMethodInput } from '../model/ruleSummary';
import { ActionFields } from './ActionFields';

/** How long `save()` waits for the server's `rules`/`error` broadcast before giving up — WS delivery on a live connection is effectively instant, so this is just a bailout for the unusual case (a dropped connection, say) where neither ever arrives and the dialog would otherwise be stuck showing "Saving…" forever. Mirrors `RuleProfilesControl`'s own `PENDING_CONFIRMATION_TIMEOUT_MS` for the same reason. */
const SAVE_TIMEOUT_MS = 5000;

/**
 * The Rules editor's body (issue #19), rendered inside a `Dialog` by
 * `RulesEditorButton`. Edits are staged in local `draftState` and only
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
// eslint-disable-next-line max-lines-per-function -- top-level panel state + save lifecycle hooks
export function RulesEditorPanel() {
  const rulesFile = useRuleStore((s) => s.rulesFile);
  const rulesFileAt = useRuleStore((s) => s.rulesFileAt);
  const unreachableWarnings = useRuleStore((s) => s.unreachableWarnings);
  const scriptWarnings = useRuleStore((s) => s.scriptWarnings);
  const setRules = useRuleStore((s) => s.setRules);
  const dirty = useRuleStore((s) => s.dirtyDraft);
  const setDirty = useRuleStore((s) => s.setDirtyDraft);
  const lastError = useRuleStore((s) => s.lastError);
  const lastErrorAt = useRuleStore((s) => s.lastErrorAt);
  const lastErrorKind = useRuleStore((s) => s.lastErrorKind);
  const dismissError = useRuleStore((s) => s.dismissError);
  const reloadError = useRuleStore((s) => s.reloadError);
  const dismissReloadError = useRuleStore((s) => s.dismissReloadError);
  const pendingNewRule = useRuleStore((s) => s.pendingNewRule);
  const clearPendingNewRule = useRuleStore((s) => s.clearPendingNewRule);

  // Seeds a queued rule (`RuleState.pendingNewRule`'s own doc comment)
  // straight into the initial draft, already selected — read once, here,
  // rather than in an effect, since this component remounts fresh every
  // time `Dialog` opens it (`RulesEditorButton`'s `open` toggles whether
  // `<RulesEditorPanel />` renders at all), so "on mount" and "the moment
  // there's a queued rule to show" are the same event for this component.
  const [draftState, setDraftState] = useState(() => createDraftRulesState(rulesFile, pendingNewRule));
  const [syncedFrom, setSyncedFrom] = useState(rulesFile);
  // `Date.now()` when `save()` last sent a `setRules` — `null` once that
  // save has resolved (either way) or nothing's been sent yet.
  const [pendingSaveAt, setPendingSaveAt] = useState<number | null>(null);
  // The server's rejection of the most recent save (e.g. failed
  // validation), if it hasn't been superseded by a later save attempt yet.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Bumped by every draft edit — `save()` snapshots the current value into
  // `savingVersion` below so `dirty` only clears if no newer edits happened
  // while the save was in flight.
  const [draftVersion, setDraftVersion] = useState(0);
  const [savingVersion, setSavingVersion] = useState<number | null>(null);
  const [sentRules, setSentRules] = useState<Rule[] | null>(null);

  // Consumes `pendingNewRule` exactly once, right after the initial draft
  // above already baked it in. Marks the draft dirty too, so Save/Discard
  // reflect there's really something unsaved and the resync-from-server
  // guard leaves it alone.
  useEffect(() => {
    if (!pendingNewRule) return;
    clearPendingNewRule();
    setDirty(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount to consume whatever pendingNewRule the initial draft already captured
  }, []);

  // Resolves a save dispatched by `save()` below against whichever of
  // `lastError`/`rulesFile` actually changes first, the same way
  // `RuleProfilesControl` resolves its own fire-and-forget WS commands.
  useEffect(() => {
    if (pendingSaveAt === null) return;
    if (
      lastError !== null &&
      lastErrorAt !== null &&
      lastErrorAt >= pendingSaveAt &&
      lastErrorKind === 'RULES_WRITE_ERROR'
    ) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setDirty/dismissError are stable store actions
  }, [
    pendingSaveAt,
    lastError,
    lastErrorAt,
    lastErrorKind,
    rulesFile,
    rulesFileAt,
    savingVersion,
    draftVersion,
    sentRules,
  ]);

  // Bails out of a save that never resolved either way — see `SAVE_TIMEOUT_MS`.
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
  // while nothing is unsaved. A dirty draft is left alone so in-progress
  // edits are never silently discarded.
  if (rulesFile !== syncedFrom && !dirty && rulesFile) {
    setSyncedFrom(rulesFile);
    setDraftState((prev) => syncDraftRulesState(prev, rulesFile));
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

  const markEdited = () => {
    setDirty(true);
    setSaveError(null);
    setDraftVersion((v) => v + 1);
  };

  const updateRule = (index: number, patch: Partial<Rule>) => {
    setDraftState((s) => updateDraftRule(s, index, patch));
    markEdited();
  };

  const updateActionJson = (index: number, text: string) => {
    setDraftState((s) => updateDraftRuleActionJson(s, index, text));
    markEdited();
  };

  const toggleJsonMode = (index: number) => {
    setDraftState((s) => toggleDraftRuleJsonMode(s, index));
  };

  const setFormError = (index: number, fieldKey: string, error: string | null) => {
    setDraftState((s) => setDraftRuleFormError(s, index, fieldKey, error));
  };

  const addRule = () => {
    setDraftState((s) => addDraftRule(s));
    markEdited();
  };

  const removeRule = (index: number) => {
    setDraftState((s) => removeDraftRule(s, index));
    markEdited();
  };

  const setSelected = (index: number | null) => {
    setDraftState((s) => ({ ...s, selected: index }));
  };

  const discard = () => {
    setDraftState((s) => ({ ...syncDraftRulesState(s, rulesFile), selected: null }));
    setSyncedFrom(rulesFile);
    setDirty(false);
    setSaveError(null);
    setPendingSaveAt(null);
    setSavingVersion(null);
    setSentRules(null);
  };

  const draftError = firstDraftRuleError(draftState);

  const save = () => {
    if (draftError !== null) {
      setSelected(draftError.ruleIndex);
      return;
    }
    const payload = toRulesFile(draftState);
    setSaveError(null);
    setPendingSaveAt(Date.now());
    setSavingVersion(draftVersion);
    setSentRules(payload.rules);
    setRules(payload);
  };

  const { entries, selected } = draftState;
  const editing = selected !== null ? entries[selected] : undefined;

  return (
    <div className="flex h-[60vh] flex-col gap-3">
      {reloadError && <ReloadErrorBanner message={reloadError} onDismiss={dismissReloadError} />}
      {/* Capped instead of flex-1 while a rule's being edited: the edit form below can run long
          (rewrite's request+response sections, breakpoint's notes, …) and needs the room more than
          this list does once something's selected. */}
      <div
        className={cn(
          'overflow-auto rounded-md border border-[var(--border)]',
          editing ? 'max-h-32 shrink-0' : 'flex-1',
        )}
      >
        {entries.length === 0 ? (
          <p className="p-3 text-sm text-[var(--muted)]">No rules yet.</p>
        ) : (
          <ul>
            {entries.map((entry, index) => (
              <RuleListRow
                key={entry.id}
                entry={entry}
                index={index}
                selected={selected === index}
                warning={dirty ? undefined : unreachableWarnings.find((w) => w.ruleIndex === index)}
                scriptWarning={dirty ? undefined : scriptWarnings.find((w) => w.ruleIndex === index)}
                onSelect={() => setSelected(index)}
                onToggleEnabled={(enabled) => updateRule(index, { enabled })}
                onRemove={() => removeRule(index)}
              />
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
            key={editing.id}
            entry={editing}
            onChange={(patch) => updateRule(selected, patch)}
            onActionJsonChange={(text) => updateActionJson(selected, text)}
            onToggleJsonMode={() => toggleJsonMode(selected)}
            onFormError={(fieldKey, error) => setFormError(selected, fieldKey, error)}
            onClose={() => setSelected(null)}
          />
        </div>
      )}

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] pt-3">
        {draftError ? (
          <p className="mr-auto text-xs text-[var(--status-5xx)]">
            Cannot save — rule &ldquo;{draftError.ruleName}&rdquo;: {draftError.message}
          </p>
        ) : (
          saveError && <p className="mr-auto text-xs text-[var(--status-5xx)]">Not saved — {saveError}</p>
        )}
        <Button variant="ghost" onClick={discard} disabled={!dirty || pendingSaveAt !== null}>
          Discard changes
        </Button>
        <Button onClick={save} disabled={!dirty || pendingSaveAt !== null || draftError !== null}>
          {pendingSaveAt !== null ? 'Saving…' : 'Save to rules.json'}
        </Button>
      </div>
    </div>
  );
}

function ReloadErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start justify-between gap-2 rounded-md border border-[var(--status-4xx)]/40 bg-[var(--status-4xx)]/10 px-3 py-2 text-xs text-[var(--status-4xx)]"
    >
      <span>
        <strong>rules.json on disk failed to reload</strong> (the proxy is still serving the last valid rules shown
        here): {message}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 hover:bg-[var(--row-hover)]"
        title="Dismiss warning"
        aria-label="Dismiss reload error"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function RuleBadge({
  message,
  className,
  children,
}: {
  message: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span role="img" aria-label={message} title={message} className={cn('shrink-0', className)}>
      {children}
    </span>
  );
}

function RuleRowBadges({
  entry,
  warning,
  scriptWarning,
}: {
  entry: DraftRuleEntry;
  warning: UnreachableRuleWarning | undefined;
  scriptWarning: ScriptGateWarning | undefined;
}) {
  const hasDraftError = entry.jsonError !== null || Object.values(entry.formErrors).some(Boolean);
  return (
    <>
      {hasDraftError && (
        <RuleBadge
          message="This rule has an invalid JSON edit that must be fixed before saving"
          className="text-[var(--status-5xx)]"
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        </RuleBadge>
      )}
      {warning && (
        <RuleBadge message={warning.message} className="text-[var(--status-4xx)]">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        </RuleBadge>
      )}
      {scriptWarning && (
        <RuleBadge message={scriptWarning.message} className="text-[var(--muted)]">
          <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
        </RuleBadge>
      )}
    </>
  );
}

function RuleListRow({
  entry,
  index,
  selected,
  warning,
  scriptWarning,
  onSelect,
  onToggleEnabled,
  onRemove,
}: {
  entry: DraftRuleEntry;
  index: number;
  selected: boolean;
  warning: UnreachableRuleWarning | undefined;
  scriptWarning: ScriptGateWarning | undefined;
  onSelect: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { rule } = entry;
  return (
    <li
      className={cn(
        'flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-sm last:border-b-0',
        selected && 'bg-[var(--row-selected)]',
      )}
    >
      <input
        type="checkbox"
        checked={rule.enabled ?? true}
        onChange={(e) => onToggleEnabled(e.target.checked)}
        title={rule.enabled === false ? 'Disabled' : 'Enabled'}
      />
      <button type="button" className="flex-1 truncate text-left" onClick={onSelect}>
        <span className="font-medium">{rule.name}</span>{' '}
        <span className="text-[var(--muted)]">— {describeMatch(rule)}</span>{' '}
        <span className="text-[10px] uppercase text-[var(--accent)]">{rule.action.type}</span>
      </button>
      <RuleRowBadges entry={entry} warning={warning} scriptWarning={scriptWarning} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        data-index={index}
        className="rounded p-1 text-[var(--muted)] hover:bg-[var(--row-hover)] hover:text-[var(--status-5xx)]"
        title="Delete rule"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function RuleMatchFields({ rule, onChange }: { rule: Rule; onChange: (patch: Partial<Rule>) => void }) {
  const [methodText, setMethodText] = useState(() => methodToEditableText(rule.match.method));
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="text-xs text-[var(--muted)]">
        Method (comma-separated, blank = any)
        <Input
          value={methodText}
          onChange={(e) => {
            setMethodText(e.target.value);
            onChange({ match: { ...rule.match, method: parseMethodInput(e.target.value) } });
          }}
          className="mt-0.5"
        />
      </label>
      <label className="text-xs text-[var(--muted)]">
        URL pattern (<code className="font-mono-ui">*</code>/<code className="font-mono-ui">?</code> wildcards)
        <Input
          value={rule.match.url ?? ''}
          onChange={(e) =>
            onChange({
              match: { ...rule.match, url: e.target.value, urlRegex: undefined, urlRegexFlags: undefined },
            })
          }
          className="mt-0.5"
        />
      </label>
    </div>
  );
}

function ActionTypeToolbar({
  actionType,
  showJson,
  jsonError,
  onSelectType,
  onToggleJsonMode,
}: {
  actionType: RuleAction['type'];
  showJson: boolean;
  jsonError: string | null;
  onSelectType: (type: RuleAction['type']) => void;
  onToggleJsonMode: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
        Action type
        <Select value={actionType} onChange={(e) => onSelectType(e.target.value as RuleAction['type'])}>
          {ACTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </label>
      <button
        type="button"
        onClick={onToggleJsonMode}
        disabled={showJson && jsonError !== null}
        title={showJson && jsonError !== null ? 'Fix JSON errors before switching back to the form' : undefined}
        className="text-xs text-[var(--muted)] underline decoration-dotted hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {showJson ? 'Use form' : 'Edit as JSON'}
      </button>
    </div>
  );
}

function RuleFields({
  entry,
  onChange,
  onActionJsonChange,
  onToggleJsonMode,
  onFormError,
  onClose,
}: {
  entry: DraftRuleEntry;
  onChange: (patch: Partial<Rule>) => void;
  onActionJsonChange: (text: string) => void;
  onToggleJsonMode: () => void;
  onFormError: (fieldKey: string, error: string | null) => void;
  onClose: () => void;
}) {
  const { rule, showJson, jsonText, jsonError } = entry;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-3">
      {/* Sticky against the scroll region RulesEditorPanel wraps this form in — a long form (rewrite's
          request+response sections, in particular) can scroll well past this point, and "Done" needs
          to stay reachable without scrolling back up to find it. */}
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
      <RuleMatchFields rule={rule} onChange={onChange} />
      <ActionTypeToolbar
        actionType={rule.action.type}
        showJson={showJson}
        jsonError={jsonError}
        onSelectType={(type) => onChange({ action: blankAction(type) })}
        onToggleJsonMode={onToggleJsonMode}
      />

      {showJson ? (
        <JsonActionField
          text={jsonText ?? JSON.stringify(rule.action, null, 2)}
          error={jsonError}
          onChange={onActionJsonChange}
        />
      ) : (
        <ActionFields
          key={rule.action.type}
          action={rule.action}
          onChange={(action) => onChange({ action })}
          onFormError={onFormError}
        />
      )}
    </div>
  );
}

/** The raw-JSON fallback for a rule's `action` — the same CodeMirror editor the Rules editor originally shipped with, kept as an escape hatch for anything `ActionFields` doesn't cover. */
function JsonActionField({
  text,
  error,
  onChange,
}: {
  text: string;
  error: string | null;
  onChange: (nextText: string) => void;
}) {
  const dark = useTheme() === 'dark';

  return (
    <div className="flex flex-col gap-1">
      {/* `height` (not a Tailwind height class on `className`) — CodeMirror
          sizes `.cm-editor` to its full content height regardless of any
          height set on an ancestor element, so a long action's JSON just
          silently became unreachable by scrolling or by cursor keys past
          10rem worth of content without this — see `JsonBodyField`'s own,
          more detailed doc comment on the same fix in ActionFields.tsx. */}
      <CodeMirror
        value={text}
        extensions={[json()]}
        theme={dark ? 'dark' : 'light'}
        basicSetup={{ lineNumbers: true, foldGutter: true }}
        onChange={onChange}
        height="10rem"
        className="rounded border border-[var(--border)] text-xs"
      />
      {error && <p className="text-xs text-[var(--status-5xx)]">{error}</p>}
    </div>
  );
}
