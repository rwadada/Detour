import { json } from '@codemirror/lang-json';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { useEffect, useState } from 'react';
import { decodeGrpcBody, useGrpcSchemaStore, type GrpcBodyDecodeResult, type GrpcDecodedFrame } from '@/entities/grpc';
import { useTheme } from '@/shared/lib/theme';
import {
  capturedByteLength,
  decodeCapturedBody,
  decodeCapturedBodyAsync,
  formatBytes,
  needsDecompression,
  tryPrettyJson,
} from '@/shared/lib/utils';
import { CopyIconButton } from '@/shared/ui';

const readOnlyView = EditorView.editable.of(false);

/**
 * Decodes a captured body, reversing `contentEncoding` (gzip/br) when
 * present, so a compressed JSON response isn't mistaken for binary (issue
 * #115).
 *
 * The overwhelming common case — no (recognized) `Content-Encoding` — takes
 * a synchronous fast path straight through `decodeCapturedBody`, exactly
 * like before this feature existed: only a body that actually needs
 * decompressing goes through `decodeCapturedBodyAsync`'s async
 * `DecompressionStream` round trip, and only *that* case can return
 * `'pending'` for the render or two before it resolves. Without this split,
 * every body — compressed or not — would flash "Decoding…" on first render,
 * a regression a review on this PR caught for the (far more common)
 * uncompressed case.
 */
function useDecodedBody(body: string | undefined, contentEncoding: string | undefined): string | undefined | 'pending' {
  const decompressing = !!body && needsDecompression(contentEncoding);
  const [result, setResult] = useState<{
    body: string;
    contentEncoding: string | undefined;
    decoded: string | undefined;
  }>();

  useEffect(() => {
    if (!decompressing || !body) return;
    let cancelled = false;
    decodeCapturedBodyAsync(body, contentEncoding)
      .then((decoded) => {
        if (!cancelled) setResult({ body, contentEncoding, decoded });
      })
      .catch(() => {
        // `decodeCapturedBodyAsync` itself resolves rather than rejects for
        // every input it knows how to fail on (PR #118 review) — this is
        // pure defense-in-depth against a future change reintroducing an
        // unhandled rejection here, which would otherwise strand `result`
        // unset and this body stuck showing "Decoding…" forever. Reported
        // the same way a genuinely undecodable body already is.
        if (!cancelled) setResult({ body, contentEncoding, decoded: undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [decompressing, body, contentEncoding]);

  if (!body) return undefined;
  if (!decompressing) return decodeCapturedBody(body);
  if (!result || result.body !== body || result.contentEncoding !== contentEncoding) return 'pending';
  return result.decoded;
}

/**
 * Decodes a captured gRPC exchange's body into its individual message
 * frames (issue #18's dashboard follow-up), delegating the actual
 * orchestration to `entities/grpc`'s `decodeGrpcBody` — see that function's
 * own doc comment. Mirrors `useDecodedBody`'s own "does this result still
 * match what's currently asked for" staleness check (comparing `body` *and*
 * `schema`, since either can change independently: a new exchange
 * selected, or the schema having just now arrived over the WS on a slow
 * connection).
 *
 * Called unconditionally by `BodyViewer` regardless of whether this
 * exchange is actually gRPC (`call`/`direction` both `undefined` when it
 * isn't) — Rules of Hooks requires every hook to run in the same order on
 * every render of a given component instance, so the actual gRPC-or-not
 * branch has to live in the *return value* `BodyViewer` renders, not in
 * whether this hook itself gets called.
 */
function useGrpcDecode(params: {
  body: string | undefined;
  call: { service: string; method: string } | undefined;
  direction: 'request' | 'response' | undefined;
  grpcEncoding: string | undefined;
  bodyTruncated: boolean | undefined;
}): GrpcBodyDecodeResult | 'pending' | undefined {
  const { body, call, direction, grpcEncoding, bodyTruncated } = params;
  const schema = useGrpcSchemaStore((s) => s.schema);
  // `schema` alone can't tell "no --proto configured" apart from "the
  // initial `protoSchema` message hasn't arrived yet" — both look like
  // `null` (see `GrpcSchemaState.schema`'s own doc comment). Without this,
  // opening a gRPC exchange's body right as the dashboard connects could
  // flash "No --proto configured" even when `--proto` *is* set, until the
  // real message lands a moment later — the same class of premature-message
  // flash a past review caught for `useDecodedBody`'s compressed-body case
  // above. `schemaAt` is only ever `null` before that first message.
  const schemaAt = useGrpcSchemaStore((s) => s.schemaAt);
  const [result, setResult] = useState<{
    body: string | undefined;
    schema: typeof schema;
    value: GrpcBodyDecodeResult;
  }>();

  useEffect(() => {
    if (!call || !direction || schemaAt === null) return;
    let cancelled = false;
    decodeGrpcBody({ body, schema, service: call.service, method: call.method, direction, grpcEncoding, bodyTruncated })
      .then((value) => {
        if (!cancelled) setResult({ body, schema, value });
      })
      .catch(() => {
        // `decodeGrpcBody` doesn't reject on any input it knows how to fail
        // on — same defensive belt-and-suspenders as `useDecodedBody`'s own
        // `.catch` above, against a future change reintroducing one.
        if (!cancelled) {
          setResult({ body, schema, value: { kind: 'unavailable', reason: 'Failed to decode this message.' } });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [call, direction, body, schema, schemaAt, grpcEncoding, bodyTruncated]);

  if (!call) return undefined;
  if (schemaAt === null) return 'pending';
  if (!result || result.body !== body || result.schema !== schema) return 'pending';
  return result.value;
}

export function BodyViewer({
  body,
  bodySize,
  truncated,
  contentEncoding,
  grpcCall,
  grpcDirection,
  grpcEncoding,
}: {
  body?: string;
  bodySize: number;
  truncated?: boolean;
  contentEncoding?: string;
  /** Set when `InspectorPanel` identified this exchange as a gRPC call — see its own `grpcCall` doc comment. `grpcDirection` is only actually `undefined` when this is too (both come from the same caller), never independently. */
  grpcCall?: { service: string; method: string };
  grpcDirection?: 'request' | 'response';
  grpcEncoding?: string;
}) {
  const dark = useTheme() === 'dark';
  const decoded = useDecodedBody(body, contentEncoding);
  const grpcResult = useGrpcDecode({
    body,
    call: grpcCall,
    direction: grpcDirection,
    grpcEncoding,
    bodyTruncated: truncated,
  });

  if (bodySize === 0) {
    return <EmptyState message="No body." />;
  }
  if (!body) {
    // Size > 0 but nothing captured: happened before the body could be read (e.g. request event fired pre-body) rather than genuinely empty.
    return <EmptyState message="Body not captured." />;
  }

  // A gRPC message body is never meaningfully readable as plain UTF-8/JSON
  // text — it's raw length-framed Protobuf bytes — so this bypasses
  // `decoded`'s normal text/JSON rendering below entirely rather than
  // trying to fold gRPC decoding into that pipeline.
  if (grpcCall) {
    if (grpcResult === 'pending' || grpcResult === undefined) {
      return <EmptyState message="Decoding…" />;
    }
    if (grpcResult.kind === 'unavailable') {
      return <EmptyState message={grpcResult.reason} />;
    }
    if (grpcResult.frames.length === 0) {
      // `framesTruncated` here means frame-splitting itself gave up partway
      // through (a truncated capture, or a still-in-flight streaming call) —
      // distinct from "nothing was ever sent", which a review on this PR
      // pointed out the single generic message below used to conflate.
      return (
        <EmptyState
          message={
            grpcResult.framesTruncated
              ? 'The captured body ended mid-frame — no complete gRPC message to decode yet.'
              : 'No gRPC messages captured.'
          }
        />
      );
    }
    return <GrpcFrameList frames={grpcResult.frames} framesTruncated={grpcResult.framesTruncated} dark={dark} />;
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

/**
 * Renders a decoded gRPC frame list — one collapsible-looking block per
 * frame. A `'message'` frame gets its own read-only JSON view (or, if it
 * failed to decode, just its error text) so one bad message in a streaming
 * call doesn't hide the rest; a trailer frame (see `GrpcDecodedFrame.trailer`'s
 * own doc comment) gets a plain-text block labeled "Trailer" instead, since
 * it's gRPC-Web's own status/message metadata, not a Protobuf message.
 */
function GrpcFrameList({
  frames,
  framesTruncated,
  dark,
}: {
  frames: GrpcDecodedFrame[];
  framesTruncated: boolean;
  dark: boolean;
}) {
  const messageCount = frames.filter((frame) => frame.trailer === undefined).length;
  const trailerCount = frames.length - messageCount;
  let messageIndex = 0;

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="border-b border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)]">
        {messageCount} message{messageCount === 1 ? '' : 's'}
        {trailerCount > 0 && `, ${trailerCount} trailer${trailerCount === 1 ? '' : 's'}`}
        {framesTruncated && ' — truncated, showing what was captured before the cutoff'}
      </div>
      <div className="flex flex-col gap-2 p-2">
        {frames.map((frame, index) => {
          const isTrailer = frame.trailer !== undefined;
          const label = isTrailer ? 'Trailer' : `Message [${messageIndex++}]`;
          return (
            <div key={index} className="overflow-hidden rounded border border-[var(--border)]">
              <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--row-hover)] px-2 py-1 text-xs text-[var(--muted)]">
                <span>{label}</span>
                {!frame.error && (
                  <CopyIconButton
                    getText={() => (isTrailer ? (frame.trailer ?? '') : JSON.stringify(frame.json, null, 2))}
                    title={isTrailer ? 'Copy trailer' : 'Copy message'}
                    className="h-5 w-5"
                  />
                )}
              </div>
              {frame.error ? (
                <p className="p-2 text-xs text-[var(--status-5xx)]">{frame.error}</p>
              ) : (
                <CodeMirror
                  value={isTrailer ? frame.trailer : JSON.stringify(frame.json, null, 2)}
                  extensions={isTrailer ? [readOnlyView] : [json(), readOnlyView]}
                  theme={dark ? 'dark' : 'light'}
                  basicSetup={{ lineNumbers: false, foldGutter: !isTrailer, highlightActiveLine: false }}
                  className="text-xs"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="flex h-full items-center justify-center text-xs text-[var(--muted)]">{message}</div>;
}
