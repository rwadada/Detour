import { json } from '@codemirror/lang-json';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { useTheme } from '@/lib/theme';
import { capturedByteLength, decodeCapturedBody, formatBytes, tryPrettyJson } from '@/lib/utils';

const readOnlyView = EditorView.editable.of(false);

export function BodyViewer({
  body,
  bodySize,
  truncated,
}: {
  body?: string;
  bodySize: number;
  truncated?: boolean;
}) {
  const dark = useTheme() === 'dark';

  if (bodySize === 0) {
    return <EmptyState message="No body." />;
  }
  if (!body) {
    // Size > 0 but nothing captured: happened before the body could be read (e.g. request event fired pre-body) rather than genuinely empty.
    return <EmptyState message="Body not captured." />;
  }

  const decoded = decodeCapturedBody(body);
  if (decoded === undefined) {
    return <EmptyState message={`Binary or non-UTF-8 body (${formatBytes(bodySize)} captured).`} />;
  }

  const { text, isJson } = tryPrettyJson(decoded);

  return (
    <div className="flex h-full flex-col">
      {truncated && (
        <div className="border-b border-[var(--border)] bg-[var(--row-hover)] px-3 py-1 text-xs text-[var(--muted)]">
          Truncated — showing the first {formatBytes(capturedByteLength(body))} of {formatBytes(bodySize)}.
        </div>
      )}
      <div className="flex-1 overflow-auto">
        <CodeMirror
          value={text}
          extensions={isJson ? [json(), readOnlyView] : [readOnlyView]}
          theme={dark ? 'dark' : 'light'}
          basicSetup={{ lineNumbers: true, foldGutter: isJson, highlightActiveLine: false }}
          className="h-full text-xs"
        />
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="flex h-full items-center justify-center text-xs text-[var(--muted)]">{message}</div>;
}
