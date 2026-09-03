import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type {
  BodyReplace,
  BodyRewrite,
  BreakpointAction,
  HeaderRewrite,
  MockAction,
  QueryRewrite,
  RewriteAction,
  RouteAction,
  RuleAction,
  ScriptAction,
} from '@/shared/api';
import { Button, Input, Select } from '@/shared/ui';
import {
  type BodyRewriteMode,
  blankBodyReplace,
  bodyRewriteMode,
  bodyValueToText,
  isEmptySetRemove,
  parseBodyValue,
  parseOptionalInt,
  removeListToText,
  setMapToText,
  textToRemoveList,
  textToSetMap,
} from '../model/actionFields';

const textareaClass =
  'w-full resize-none rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 font-mono-ui text-xs ' +
  'placeholder:text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/**
 * A structured, non-JSON form for a rule's `action` — dispatches to a
 * dedicated sub-form per action type, since the five shapes (`mock`/
 * `route`/`rewrite`/`breakpoint`/`script`) don't share enough fields for one
 * generic form. Callers should mount this keyed by something that changes
 * per-rule (e.g. `key={rule.name}`, as `RulesEditorPanel` does) so each
 * rule's sub-forms start from a fresh local edit buffer rather than trying
 * to reconcile one rule's in-progress text against another's.
 */
export function ActionFields({ action, onChange }: { action: RuleAction; onChange: (action: RuleAction) => void }) {
  switch (action.type) {
    case 'mock':
      return <MockActionFields action={action} onChange={onChange} />;
    case 'route':
      return <RouteActionFields action={action} onChange={onChange} />;
    case 'rewrite':
      return <RewriteActionFields action={action} onChange={onChange} />;
    case 'breakpoint':
      return <BreakpointActionFields action={action} onChange={onChange} />;
    case 'script':
      return <ScriptActionFields action={action} onChange={onChange} />;
  }
}

function MockActionFields({ action, onChange }: { action: MockAction; onChange: (action: MockAction) => void }) {
  const [headersText, setHeadersText] = useState(() => setMapToText(action.headers));
  const [bodySource, setBodySource] = useState<'inline' | 'file'>(() => (action.bodyFile ? 'file' : 'inline'));
  const [bodyText, setBodyText] = useState(() => bodyValueToText(action.body));
  const [bodyFileText, setBodyFileText] = useState(() => action.bodyFile ?? '');

  const patch = (p: Partial<MockAction>) => onChange({ ...action, ...p });
  const simulating = action.simulate !== undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Status code">
          <Input
            type="number"
            value={action.status ?? 200}
            onChange={(e) => patch({ status: parseOptionalInt(e.target.value) })}
          />
        </Field>
        <Field label="Status message (optional)">
          <Input
            value={action.statusMessage ?? ''}
            onChange={(e) => patch({ statusMessage: e.target.value || undefined })}
          />
        </Field>
      </div>

      <Field label="Simulate a broken connection instead of responding">
        <Select
          value={action.simulate ?? ''}
          onChange={(e) => {
            const value = e.target.value as '' | 'timeout' | 'close';
            // Wins over status/headers/body/bodyFile (see MockAction's own
            // doc comment) and the schema forbids combining simulate with
            // body/bodyFile — clear them so switching to simulate always
            // produces a valid rule.
            onChange({
              ...action,
              simulate: value || undefined,
              ...(value ? { body: undefined, bodyFile: undefined } : {}),
            });
          }}
        >
          <option value="">No — send a real response</option>
          <option value="timeout">Timeout — hang the connection until the client gives up</option>
          <option value="close">Close — reset the connection immediately</option>
        </Select>
      </Field>

      {!simulating && (
        <>
          <Field label='Headers (one per line, "Name: value")'>
            <textarea
              className={textareaClass}
              rows={3}
              value={headersText}
              onChange={(e) => {
                setHeadersText(e.target.value);
                patch({ headers: textToSetMap(e.target.value) });
              }}
            />
          </Field>

          <Field label="Response body">
            <Select
              value={bodySource}
              onChange={(e) => {
                const source = e.target.value as 'inline' | 'file';
                setBodySource(source);
                patch(
                  source === 'inline'
                    ? { body: parseBodyValue(bodyText), bodyFile: undefined }
                    : { bodyFile: bodyFileText || undefined, body: undefined },
                );
              }}
              className="mb-1"
            >
              <option value="inline">Type it in below</option>
              <option value="file">Read from a file</option>
            </Select>
            {bodySource === 'inline' ? (
              <textarea
                className={textareaClass}
                rows={4}
                value={bodyText}
                placeholder='Plain text, or JSON like {"id": 1}'
                onChange={(e) => {
                  setBodyText(e.target.value);
                  patch({ body: parseBodyValue(e.target.value) });
                }}
              />
            ) : (
              <Input
                value={bodyFileText}
                placeholder="path/to/body.json (relative to rules.json)"
                onChange={(e) => {
                  setBodyFileText(e.target.value);
                  patch({ bodyFile: e.target.value || undefined });
                }}
              />
            )}
          </Field>
        </>
      )}

      <Field label="Delay before responding, in milliseconds (optional)">
        <Input
          type="number"
          value={action.delayMs ?? ''}
          onChange={(e) => patch({ delayMs: parseOptionalInt(e.target.value) })}
          className="w-32"
        />
      </Field>
    </div>
  );
}

function RouteActionFields({ action, onChange }: { action: RouteAction; onChange: (action: RouteAction) => void }) {
  const patch = (p: Partial<RouteAction>) => onChange({ ...action, ...p });
  return (
    <div className="flex flex-col gap-2">
      <Field label="Redirect the request to this host">
        <Input
          value={action.host}
          onChange={(e) => patch({ host: e.target.value })}
          placeholder="staging.example.com"
        />
      </Field>
      <Field label="Port (optional — defaults to the request's original port)">
        <Input
          type="number"
          value={action.port ?? ''}
          onChange={(e) => patch({ port: parseOptionalInt(e.target.value) })}
          className="w-32"
        />
      </Field>
      <Checkbox
        checked={action.preserveHostHeader ?? true}
        onChange={(checked) => patch({ preserveHostHeader: checked ? undefined : false })}
      >
        Keep the original Host header (so the new destination still sees the request as addressed to the original host)
      </Checkbox>
    </div>
  );
}

function BreakpointActionFields({
  action,
  onChange,
}: {
  action: BreakpointAction;
  onChange: (action: BreakpointAction) => void;
}) {
  const requestOn = action.request ?? true;
  const responseOn = action.response ?? true;

  // A breakpoint that pauses neither phase would never fire — mirror the
  // server-side validation (rules.json's own schema rejects this) by simply
  // not letting the second checkbox turn off while the other is already off.
  const setPhase = (phase: 'request' | 'response', checked: boolean) => {
    const other = phase === 'request' ? responseOn : requestOn;
    if (!checked && !other) return;
    onChange({ ...action, [phase]: checked ? undefined : false });
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-[var(--muted)]">
        Pauses a matching exchange for live editing from this dashboard before it continues. There's no timeout — only
        enable this while you're actively watching.
      </p>
      <Checkbox checked={requestOn} onChange={(c) => setPhase('request', c)}>
        Pause before the request is sent upstream
      </Checkbox>
      <Checkbox checked={responseOn} onChange={(c) => setPhase('response', c)}>
        Pause before the response is returned to the client
      </Checkbox>
    </div>
  );
}

function ScriptActionFields({ action, onChange }: { action: ScriptAction; onChange: (action: ScriptAction) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <Field label="Script file path (relative to rules.json)">
        <Input
          value={action.path}
          onChange={(e) => onChange({ ...action, path: e.target.value })}
          placeholder="./rules.script.js"
        />
      </Field>
      <p className="text-xs text-[var(--muted)]">
        Points at a small JavaScript file exporting <code className="font-mono-ui">beforeRequest</code>/
        <code className="font-mono-ui">beforeResponse</code> functions for logic a form can't express — that's real
        code, so it's written in your own text editor, not here. Editing the file takes effect immediately, the same as
        this rules file.
      </p>
    </div>
  );
}

function SetRemoveFields({
  label,
  value,
  onChange,
  setPlaceholder,
}: {
  label: string;
  value: HeaderRewrite | QueryRewrite | undefined;
  onChange: (value: HeaderRewrite | QueryRewrite | undefined) => void;
  setPlaceholder?: string;
}) {
  const [setText, setSetText] = useState(() => setMapToText(value?.set));
  const [removeText, setRemoveText] = useState(() => removeListToText(value?.remove));

  const commit = (nextSetText: string, nextRemoveText: string) => {
    const next: HeaderRewrite = { set: textToSetMap(nextSetText), remove: textToRemoveList(nextRemoveText) };
    onChange(isEmptySetRemove(next) ? undefined : next);
  };

  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label={`${label} — add/set (one per line, "name: value")`}>
        <textarea
          className={textareaClass}
          rows={3}
          value={setText}
          placeholder={setPlaceholder}
          onChange={(e) => {
            setSetText(e.target.value);
            commit(e.target.value, removeText);
          }}
        />
      </Field>
      <Field label={`${label} — remove (comma-separated names)`}>
        <textarea
          className={textareaClass}
          rows={3}
          value={removeText}
          onChange={(e) => {
            setRemoveText(e.target.value);
            commit(setText, e.target.value);
          }}
        />
      </Field>
    </div>
  );
}

function BodyRewriteFields({
  value,
  onChange,
}: {
  value: BodyRewrite | undefined;
  onChange: (value: BodyRewrite | undefined) => void;
}) {
  const [mode, setMode] = useState<BodyRewriteMode>(() => bodyRewriteMode(value));
  const [setText, setSetText] = useState(() => bodyValueToText(value?.set));
  const [mergeText, setMergeText] = useState(() => bodyValueToText(value?.merge));
  const [replaceRows, setReplaceRows] = useState<BodyReplace[]>(() => value?.replace ?? []);

  // `replace` and `merge` compose (see `BodyRewriteMode`'s doc comment), so
  // "transform" mode always emits both together — editing one must never
  // silently drop whatever the other already held.
  const emitTransform = (overrides: { mergeText?: string; rows?: BodyReplace[] } = {}) => {
    const rows = overrides.rows ?? replaceRows;
    const merge = parseBodyValue(overrides.mergeText ?? mergeText);
    const next: BodyRewrite = {};
    if (rows.length > 0) next.replace = rows;
    if (merge !== undefined) next.merge = merge;
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };

  const emit = (nextMode: BodyRewriteMode, overrides: { setText?: string } = {}) => {
    if (nextMode === 'none') return onChange(undefined);
    if (nextMode === 'set') return onChange({ set: parseBodyValue(overrides.setText ?? setText) });
    return emitTransform();
  };

  const updateRow = (index: number, patch: Partial<BodyReplace>) => {
    const rows = replaceRows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    setReplaceRows(rows);
    emitTransform({ rows });
  };

  const addRow = () => {
    const rows = [...replaceRows, blankBodyReplace()];
    setReplaceRows(rows);
    emitTransform({ rows });
  };

  const removeRow = (index: number) => {
    const rows = replaceRows.filter((_, i) => i !== index);
    setReplaceRows(rows);
    emitTransform({ rows });
  };

  return (
    <div className="flex flex-col gap-2">
      <Field label="Body">
        <Select
          value={mode}
          onChange={(e) => {
            const nextMode = e.target.value as BodyRewriteMode;
            setMode(nextMode);
            emit(nextMode);
          }}
        >
          <option value="none">Don't touch it</option>
          <option value="set">Replace it entirely</option>
          <option value="transform">Find &amp; replace text, or merge JSON</option>
        </Select>
      </Field>

      {mode === 'set' && (
        <textarea
          className={textareaClass}
          rows={4}
          value={setText}
          placeholder='Plain text, or JSON like {"id": 1}'
          onChange={(e) => {
            setSetText(e.target.value);
            emit('set', { setText: e.target.value });
          }}
        />
      )}

      {mode === 'transform' && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-[var(--muted)]">Find &amp; replace text (runs first, in order)</span>
            {replaceRows.map((row, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <Input
                  className="flex-1"
                  value={row.find}
                  placeholder="find"
                  onChange={(e) => updateRow(index, { find: e.target.value })}
                />
                <Input
                  className="flex-1"
                  value={row.replacement}
                  placeholder="replacement"
                  onChange={(e) => updateRow(index, { replacement: e.target.value })}
                />
                <label
                  className="flex shrink-0 items-center gap-1 text-xs text-[var(--muted)]"
                  title="Treat “find” as a regular expression instead of literal text"
                >
                  <input
                    type="checkbox"
                    checked={row.regex ?? false}
                    onChange={(e) => updateRow(index, { regex: e.target.checked || undefined })}
                  />
                  regex
                </label>
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  className="shrink-0 rounded p-1 text-[var(--muted)] hover:bg-[var(--row-hover)] hover:text-[var(--status-5xx)]"
                  title="Remove this find/replace"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={addRow} className="w-fit gap-1">
              <Plus className="h-3.5 w-3.5" /> Add find/replace
            </Button>
          </div>

          <Field label="Then merge into the JSON body (optional)">
            <textarea
              className={textareaClass}
              rows={3}
              value={mergeText}
              placeholder='{"status": "confirmed"} — a null value deletes that key'
              onChange={(e) => {
                setMergeText(e.target.value);
                emitTransform({ mergeText: e.target.value });
              }}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function RewriteActionFields({
  action,
  onChange,
}: {
  action: RewriteAction;
  onChange: (action: RewriteAction) => void;
}) {
  const patchRequest = (p: Partial<NonNullable<RewriteAction['request']>>) => {
    const next = { ...action.request, ...p };
    const empty = isEmptySetRemove(next.headers) && isEmptySetRemove(next.query) && next.body === undefined;
    onChange({ ...action, request: empty ? undefined : next });
  };
  const patchResponse = (p: Partial<NonNullable<RewriteAction['response']>>) => {
    const next = { ...action.response, ...p };
    const empty = isEmptySetRemove(next.headers) && next.body === undefined && next.status === undefined;
    onChange({ ...action, response: empty ? undefined : next });
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          Request — before it's sent
        </h4>
        <SetRemoveFields
          label="Query params"
          value={action.request?.query}
          onChange={(v) => patchRequest({ query: v })}
        />
        <SetRemoveFields
          label="Headers"
          value={action.request?.headers}
          onChange={(v) => patchRequest({ headers: v })}
        />
        <BodyRewriteFields value={action.request?.body} onChange={(v) => patchRequest({ body: v })} />
      </section>

      <section className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
          Response — before it's returned
        </h4>
        <Field label="Status code (optional)">
          <Input
            type="number"
            value={action.response?.status ?? ''}
            onChange={(e) => patchResponse({ status: parseOptionalInt(e.target.value) })}
            className="w-32"
          />
        </Field>
        <SetRemoveFields
          label="Headers"
          value={action.response?.headers}
          onChange={(v) => patchResponse({ headers: v })}
        />
        <BodyRewriteFields value={action.response?.body} onChange={(v) => patchResponse({ body: v })} />
      </section>
    </div>
  );
}
