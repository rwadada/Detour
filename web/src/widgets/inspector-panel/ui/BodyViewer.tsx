import { json } from '@codemirror/lang-json';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { useEffect, useState } from 'react';
import { useTheme } from '@/shared/lib/theme';
import { capturedByteLength, decodeCapturedBodyAsync, formatBytes, tryPrettyJson } from '@/shared/lib/utils';
import { CopyIconButton } from '@/shared/ui';

const readOnlyView = EditorView.editable.of(false);

/**
 * Decodes a captured body, reversing `contentEncoding` (gzip/br) when
 * present, so a compressed JSON response isn't mistaken for binary (issue
 * #115). Decompression is async (`DecompressionStream`), so this returns
 * `'pending'` until the decode for the current `(body, contentEncoding)`
 * pair resolves — kept as a stale/current comparison, rather than an
 * effect that resets state synchronously on every body change, per the
 * react-hooks/set-state-in-effect rule.
 */
function useDecodedBody(body: string | undefined, contentEncoding: string | undefined): string | undefined | 'pending' {
  const [result, setResult] = useState<{
    body: string;
    contentEncoding: string | undefined;
    decoded: string | undefined;
  }>();

  useEffect(() => {
    if (!body) return;
    let cancelled = false;
    decodeCapturedBodyAsync(body, contentEncoding).then((decoded) => {
      if (!cancelled) setResult({ body, contentEncoding, decoded });
    });
    return () => {
      cancelled = true;
    };
  }, [body, contentEncoding]);

  if (!body) return undefined;
  if (!result || result.body !== body || result.contentEncoding !== contentEncoding) return 'pending';
  return result.decoded;
}

export function BodyViewer({
  body,
  bodySize,
  truncated,
  contentEncoding,
}: {
  body?: string;
  bodySize: number;
  truncated?: boolean;
  contentEncoding?: string;
}) {
  const dark = useTheme() === 'dark';
  const decoded = useDecodedBody(body, contentEncoding);

  if (bodySize === 0) {
    return <EmptyState message="No body." />;
  }
  if (!body) {
    // Size > 0 but nothing captured: happened before the body could be read (e.g. request event fired pre-body) rather than genuinely empty.
    return <EmptyState message="Body not captured." />;
  }
  if (decoded === 'pending') {
    return <EmptyState message="Decoding…" />;
  }
  if (decoded === undefined) {
    return <EmptyState message={`Binary or non-UTF-8 body (${formatBytes(bodySize)} captured).`} />;
  }

  const { text, isJson } = tryPrettyJson(decoded);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)]">
        <span>
          {truncated &&
            `Truncated — showing the first ${formatBytes(capturedByteLength(body))} of ${formatBytes(bodySize)}.`}
        </span>
        <CopyIconButton getText={() => text} title="Copy body" className="h-5 w-5 shrink-0" />
      </div>
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
