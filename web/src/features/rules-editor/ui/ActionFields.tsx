import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type {
  BodyReplace,
  BodyRewrite,
  BreakpointAction,
  HeaderRewrite,
  MockAction,
  PathRewrite,
  QueryRewrite,
  RewriteAction,
  RouteAction,
  RuleAction,
  ScriptAction,
} from '@/shared/api';
import { useTheme } from '@/shared/lib/theme';
import { Button, Input, Select } from '@/shared/ui';
import {
  type BodyRewriteMode,
  type PathRewriteMode,
  blankBodyReplace,
  bodyRewriteMode,
  bodyValueToText,
  describeJsonBodyText,
  isEmptySetRemove,
  parseBodyValue,
  parseOptionalInt,
  pathRewriteMode,
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
 * A body-value editor shared by Mock's response body and Body Rewrite's
 * "set"/"merge" fields — all three accept the same free-text shape
 * (`parseBodyValue`/`bodyValueToText`'s own doc comment: valid JSON becomes
 * a parsed value, anything else is kept as a literal string). A plain
 * `<textarea>` here made a hand-written object painful in the way any JSON
 * without an editor is — no syntax highlighting or bracket matching to
 * catch a stray comma/quote — and, worse, made that mistake invisible: a
 * body that was *meant* to be `{"id": 1}` but has a typo silently becomes
 * the literal string `{"id": 1` instead of failing loudly, since that
 * fallback is deliberately how a genuine plain-text body (this field's
 * other legitimate use) is allowed to work at all.
 *
 * This reuses `JsonActionField`'s own CodeMirror setup for the editing
 * surface — line numbers and fold gutter included, since a hand-written
 * mock body is exactly the case that tends to run long enough that "which
 * line is the stray comma on" and "collapse this nested object I'm not
 * touching right now" both start to matter — then adds a status line making
 * which of those two outcomes is about to be saved explicit, plus a
 * one-click reformat once it's valid, so getting a long JSON body right
 * doesn't depend on manually eyeballing brackets or re-typing indentation
 * by hand.
 */
function JsonBodyField({
  value,
  onChange,
  placeholder,
  height = '10rem',
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  /** Passed straight through to `CodeMirror`'s own `height` prop — see this component's own height/scrolling doc comment below for why a Tailwind height class on the wrapper `className` doesn't work here. */
  height?: string;
}) {
  const dark = useTheme() === 'dark';
  const { validJson, parsed, status } = describeJsonBodyText(value);

  return (
    <div className="flex flex-col gap-1">
      {/* `height` (not a Tailwind height class on `className`) is required
          for a long value to actually scroll: CodeMirror sizes `.cm-editor`
          to its full content height by default regardless of any height set
          on an ancestor element, and only a `height`/`maxHeight` *prop*
          (which `@uiw/react-codemirror` turns into an `EditorView.theme`
          rule directly on `.cm-editor`, matched by its own always-on
          `.cm-scroller { height: 100% }` rule) makes `.cm-scroller` an
          actually-shorter-than-its-content scroll container. Without this,
          a wrapper `className="h-40 overflow-hidden"` still visually clips
          the editor at 10rem like intended, but CodeMirror itself never
          sees anything to scroll — so once the content exceeds that height,
          the rest becomes permanently unreachable by scrolling *or* by
          arrow keys walking the cursor down into it (a bug report caught
          this: cursor keys and scrolling both silently stopped working). */}
      <CodeMirror
        value={value}
        extensions={[json(), EditorView.lineWrapping]}
        theme={dark ? 'dark' : 'light'}
        basicSetup={{ lineNumbers: true, foldGutter: true }}
        placeholder={placeholder}
        onChange={onChange}
        height={height}
        className="overflow-hidden rounded-md border border-[var(--border)] text-xs"
      />
      <div className="flex items-center justify-between text-[10px] text-[var(--muted)]">
        <span>{status}</span>
        {validJson && (
          <button
            type="button"
            onClick={() => onChange(JSON.stringify(parsed, null, 2))}
            className="underline decoration-dotted hover:text-[var(--foreground)]"
          >
            Format
          </button>
        )}
      </div>
    </div>
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

          {/* `Select` deliberately gets its own `Field`/`<label>`, not one
              shared with the editor below (issue #126) — a `<label>`
              wrapping more than one native form control redirects a click
              anywhere inside it that doesn't land on an interactive element
              of its own to that label's implicit target (the first
              labelable descendant, here the `Select`). `JsonBodyField`'s
              CodeMirror instance is a `contentEditable` div, not a native
              labelable control, so it never claims that click itself —
              every click meant for the editor was instead focusing (and
              typing into) the `Select` sitting next to it. `BodyRewriteFields`'s
              own "merge" `JsonBodyField` already avoids this by never
              sharing a `Field` with a `Select` to begin with. The value
              editor/input below gets its *own* `Field` too (rather than no
              `Field` at all) — each label ends up wrapping exactly one
              control either way, so the click-forwarding bug above can't
              recur, but the value control still has a real associated
              label instead of none (a review on this PR caught the
              no-label version as its own, new accessibility regression). */}
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
            >
              <option value="inline">Type it in below</option>
              <option value="file">Read from a file</option>
            </Select>
          </Field>
          {bodySource === 'inline' ? (
            <Field label="Response body value">
              <JsonBodyField
                value={bodyText}
                placeholder='Plain text, or JSON like {"id": 1}'
                onChange={(text) => {
                  setBodyText(text);
                  patch({ body: parseBodyValue(text) });
                }}
              />
            </Field>
          ) : (
            <Field label="Response body file path">
              <Input
                value={bodyFileText}
                placeholder="path/to/body.json (relative to rules.json)"
                onChange={(e) => {
                  setBodyFileText(e.target.value);
                  patch({ bodyFile: e.target.value || undefined });
                }}
              />
            </Field>
          )}
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

/**
 * Shared find/replace list editor for a `BodyReplace[]` — the row shape and
 * semantics (`find`/`replacement`/`regex`/`flags`) are identical wherever
 * find/replace applies, whether to a body (`applyBodyRewrite`) or a URL path
 * (`applyPathRewrite`); both explicitly document reusing the same
 * semantics. Used by `BodyRewriteFields`'s "transform" mode and
 * `PathRewriteFields`'s "replace" mode.
 */
function ReplaceRowsEditor({
  rows,
  onChange,
  helpText,
}: {
  rows: BodyReplace[];
  onChange: (rows: BodyReplace[]) => void;
  helpText: ReactNode;
}) {
  const updateRow = (index: number, patch: Partial<BodyReplace>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const addRow = () => onChange([...rows, blankBodyReplace()]);
  const removeRow = (index: number) => onChange(rows.filter((_, i) => i !== index));

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-[var(--muted)]">{helpText}</span>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            className="flex-1"
            value={row.find}
            placeholder="find"
            aria-label={`Find text for find/replace row ${index + 1}`}
            onChange={(e) => updateRow(index, { find: e.target.value })}
          />
          <Input
            className="flex-1"
            value={row.replacement}
            placeholder="replacement"
            aria-label={`Replacement text for find/replace row ${index + 1}`}
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
            aria-label={`Remove find/replace row ${index + 1}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={addRow} className="w-fit gap-1">
        <Plus className="h-3.5 w-3.5" /> Add find/replace
      </Button>
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
        <JsonBodyField
          value={setText}
          placeholder='Plain text, or JSON like {"id": 1}'
          onChange={(text) => {
            setSetText(text);
            emit('set', { setText: text });
          }}
        />
      )}

      {mode === 'transform' && (
        <div className="flex flex-col gap-3">
          <ReplaceRowsEditor
            rows={replaceRows}
            helpText="Find & replace text (runs first, in order)"
            onChange={(rows) => {
              setReplaceRows(rows);
              emitTransform({ rows });
            }}
          />

          <Field label="Then merge into the JSON body (optional)">
            <JsonBodyField
              value={mergeText}
              placeholder='{"status": "confirmed"} — a null value deletes that key'
              height="5rem"
              onChange={(text) => {
                setMergeText(text);
                emitTransform({ mergeText: text });
              }}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

/**
 * A structured form for a rule's `request.path` rewrite (issue: the Rules
 * editor GUI had no way to touch this at all — only "Edit as JSON" could,
 * despite `path` being how a path *parameter* like the `1` in `/users/1`
 * gets rewritten, per `PathRewrite`'s own doc comment). No `merge` mode
 * (unlike `BodyRewriteFields`) — a URL path has no such concept.
 */
function PathRewriteFields({
  value,
  onChange,
}: {
  value: PathRewrite | undefined;
  onChange: (value: PathRewrite | undefined) => void;
}) {
  const [mode, setMode] = useState<PathRewriteMode>(() => pathRewriteMode(value));
  const [setText, setSetText] = useState(() => value?.set ?? '');
  const [replaceRows, setReplaceRows] = useState<BodyReplace[]>(() => value?.replace ?? []);

  const emit = (nextMode: PathRewriteMode, overrides: { setText?: string; rows?: BodyReplace[] } = {}) => {
    if (nextMode === 'none') return onChange(undefined);
    if (nextMode === 'set') {
      // Trim before persisting (not just to decide whether the field is
      // "empty") — `path.set` must start with "/" and is sent verbatim as
      // the request-target, so stray leading/trailing whitespace would
      // either fail that validation or reach the wire malformed. The input
      // itself stays untrimmed as the user types it; only the saved value
      // is normalized.
      const text = (overrides.setText ?? setText).trim();
      return onChange(text === '' ? undefined : { set: text });
    }
    const rows = overrides.rows ?? replaceRows;
    return onChange(rows.length > 0 ? { replace: rows } : undefined);
  };

  return (
    <div className="flex flex-col gap-2">
      <Field label="Path">
        <Select
          value={mode}
          onChange={(e) => {
            const nextMode = e.target.value as PathRewriteMode;
            setMode(nextMode);
            emit(nextMode);
          }}
        >
          <option value="none">Don't touch it</option>
          <option value="set">Replace it entirely</option>
          <option value="replace">Find &amp; replace text</option>
        </Select>
      </Field>

      {mode === 'set' && (
        <Field label="New path — must start with / and not contain ?/# (the request's query string is kept as-is)">
          <Input
            value={setText}
            placeholder="/people/1"
            onChange={(e) => {
              setSetText(e.target.value);
              emit('set', { setText: e.target.value });
            }}
          />
        </Field>
      )}

      {mode === 'replace' && (
        <ReplaceRowsEditor
          rows={replaceRows}
          helpText={
            <>
              Find &amp; replace text — regex capture groups like <code>$1</code> work in "replacement" when "regex" is
              checked (e.g. find <code>/users/(\d+)</code>, replacement <code>/people/$1</code>)
            </>
          }
          onChange={(rows) => {
            setReplaceRows(rows);
            emit('replace', { rows });
          }}
        />
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
    const empty =
      next.path === undefined &&
      isEmptySetRemove(next.headers) &&
      isEmptySetRemove(next.query) &&
      next.body === undefined;
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
        <PathRewriteFields value={action.request?.path} onChange={(v) => patchRequest({ path: v })} />
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
