import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';
import { useEffect, useState } from 'react';
import { decodeGrpcBody, useGrpcSchemaStore, type GrpcBodyDecodeResult, type GrpcDecodedFrame } from '@/entities/grpc';
import { useTheme } from '@/shared/lib/theme';
import {
  capturedByteLength,
  decodeCapturedBody,
  decodeCapturedBodyAsync,
  decodeCapturedBytesAsync,
  formatBytes,
  needsDecompression,
  tryPrettyJson,
} from '@/shared/lib/utils';
import { CopyIconButton } from '@/shared/ui';
import {
  detectBodyFormat,
  extractMultipartBoundary,
  formatXml,
  parseFormUrlEncoded,
  parseMultipartFormData,
  type BodyFormat,
  type MultipartField,
} from '../model/bodyFormat';

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
 * Decodes a captured `image/*` body (issue #142) into a `Blob` object URL
 * `<img>` can load directly, reversing `contentEncoding` first via
 * `decodeCapturedBytesAsync` — never through `useDecodedBody`'s UTF-8 text
 * pipeline, which would corrupt (or reject as "binary") the raw bytes.
 * `enabled` gates this on `BodyViewer` having already classified the body
 * as an image, so a non-image body never pays for a pointless decode.
 * Revokes the previous object URL whenever a new one replaces it (or this
 * unmounts) — otherwise every exchange inspected this way leaks a Blob for
 * the life of the tab.
 */
function useImageObjectUrl(
  body: string | undefined,
  contentType: string | undefined,
  contentEncoding: string | undefined,
  enabled: boolean,
): string | undefined | 'pending' {
  const [result, setResult] = useState<{ body: string; url: string }>();

  useEffect(() => {
    if (!enabled || !body || !contentType) return;
    let cancelled = false;
    decodeCapturedBytesAsync(body, contentEncoding).then((bytes) => {
      if (cancelled || !bytes) return;
      const url = URL.createObjectURL(new Blob([bytes as BufferSource], { type: contentType }));
      setResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { body, url };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, body, contentType, contentEncoding]);

  // Revokes the very last object URL created once this instance unmounts —
  // the effect above already revokes every *earlier* one as it's replaced,
  // but nothing else ever runs to catch the final one.
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup, intentionally not re-running per `result` change (that's the effect above's job).
  }, []);

  if (!enabled) return undefined;
  if (!result || result.body !== body) return 'pending';
  return result.url;
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

/** The CodeMirror language extension (if any) matching `format` — `undefined` for the table-rendered/image formats, which never reach CodeMirror at all. */
function languageExtensionFor(format: BodyFormat): Extension | undefined {
  switch (format) {
    case 'html':
      return html();
    case 'css':
      return css();
    case 'javascript':
      return javascript();
    case 'xml':
      return xml();
    case 'json':
      return json();
    default:
      return undefined;
  }
}

export function BodyViewer({
  body,
  bodySize,
  truncated,
  contentType,
  contentEncoding,
  grpcCall,
  grpcDirection,
  grpcEncoding,
}: {
  body?: string;
  bodySize: number;
  truncated?: boolean;
  /** The request/response's `content-type` header (issue #142), driving which format `BodyViewer` renders it as — see `detectBodyFormat`. */
  contentType?: string;
  contentEncoding?: string;
  /** Set when `InspectorPanel` identified this exchange as a gRPC call — see its own `grpcCall` doc comment. `grpcDirection` is only actually `undefined` when this is too (both come from the same caller), never independently. */
  grpcCall?: { service: string; method: string };
  grpcDirection?: 'request' | 'response';
  grpcEncoding?: string;
}) {
  const dark = useTheme() === 'dark';
  const format = detectBodyFormat(contentType);
  const decoded = useDecodedBody(format === 'image' ? undefined : body, contentEncoding);
  const imageUrl = useImageObjectUrl(body, contentType, contentEncoding, format === 'image');
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

  // An image is previewed straight from its raw (decompressed) bytes — it
  // never goes through `decoded`'s UTF-8 text pipeline at all, so this
  // branches before either of `decoded`'s own pending/undefined checks
  // below, which don't apply to it.
  if (format === 'image') {
    if (imageUrl === 'pending' || imageUrl === undefined) {
      return <EmptyState message="Decoding…" />;
    }
    return <ImageBodyView src={imageUrl} truncated={truncated} bodySize={bodySize} />;
  }

  if (decoded === 'pending') {
    return <EmptyState message="Decoding…" />;
  }
  if (decoded === undefined) {
    return <EmptyState message={`Binary or non-UTF-8 body (${formatBytes(bodySize)} captured).`} />;
  }

  return (
    <TextBodyView
      decoded={decoded}
      format={format}
      contentType={contentType}
      body={body}
      bodySize={bodySize}
      truncated={truncated}
      dark={dark}
    />
  );
}

/**
 * Renders a body that decoded to text (issue #142) — everything past
 * `BodyViewer`'s own image/gRPC/pending/binary early-returns above. Split
 * out purely to keep `BodyViewer` itself short: this is the one format
 * dispatch (form-urlencoded/multipart table vs. a CodeMirror view, and
 * which language extension to load) that actually needs `decoded`.
 */
function TextBodyView({
  decoded,
  format,
  contentType,
  body,
  bodySize,
  truncated,
  dark,
}: {
  decoded: string;
  format: BodyFormat;
  contentType: string | undefined;
  body: string;
  bodySize: number;
  truncated: boolean | undefined;
  dark: boolean;
}) {
  if (format === 'form-urlencoded') {
    return <FieldsTable fields={parseFormUrlEncoded(decoded).map(([name, value]) => ({ name, value }))} />;
  }
  if (format === 'multipart') {
    const boundary = extractMultipartBoundary(contentType);
    // No boundary parameter to split on (a malformed Content-Type) — falls
    // through to the plain-text rendering below rather than showing an
    // empty table that looks like the body genuinely has no fields.
    if (boundary) {
      return <FieldsTable fields={parseMultipartFormData(decoded, boundary)} />;
    }
  }

  // `xml`: reformatted, since a captured body is very often minified/single-
  // line on the wire. `html`/`css`/`javascript`: shown as captured — a
  // reformatter for each of those is a lot more machinery than a debug body
  // viewer needs, and each is usually already reasonably formatted source
  // (unlike XML API payloads, which are routinely minified). `json`/`text`:
  // unchanged from this component's pre-#142 behavior — try pretty-printing
  // as JSON regardless of what the header actually claimed, since plenty of
  // APIs mislabel a JSON body as `text/plain`.
  const { text, isJson } = format === 'xml' ? { text: formatXml(decoded), isJson: false } : tryPrettyJson(decoded);
  const extension = languageExtensionFor(format) ?? (isJson ? json() : undefined);
  const structuredFormats: BodyFormat[] = ['json', 'html', 'css', 'javascript', 'xml'];
  const foldable = structuredFormats.includes(format) || isJson;

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
          extensions={extension ? [extension, readOnlyView] : [readOnlyView]}
          theme={dark ? 'dark' : 'light'}
          basicSetup={{ lineNumbers: true, foldGutter: foldable, highlightActiveLine: false }}
          className="h-full text-xs"
        />
      </div>
    </div>
  );
}

/** Full-bleed `<img>` preview for an `image/*` body (issue #142) — `src` is a `Blob` object URL from `useImageObjectUrl`, already reversing any `Content-Encoding`. A malformed/truncated capture simply fails to decode as an image; the browser's own broken-image placeholder is enough of a signal, so this doesn't try to detect that case itself. */
function ImageBodyView({
  src,
  truncated,
  bodySize,
}: {
  src: string;
  truncated: boolean | undefined;
  bodySize: number;
}) {
  return (
    <div className="flex h-full flex-col">
      {truncated && (
        <div className="border-b border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)]">
          Truncated — the capture was cut off before {formatBytes(bodySize)} finished downloading; the preview below may
          be incomplete or fail to render.
        </div>
      )}
      <div className="flex flex-1 items-center justify-center overflow-auto p-3">
        <img src={src} alt="Captured body" className="max-h-full max-w-full object-contain" />
      </div>
    </div>
  );
}

/** Key/value table for a `form-urlencoded`/`multipart` body (issue #142) — a file field (`filename` set) shows its filename/content-type/size instead of a `value`, which is always empty for those (see `MultipartField.value`'s doc comment). */
function FieldsTable({ fields }: { fields: Array<{ name: string; value: string } | MultipartField> }) {
  if (fields.length === 0) {
    return <EmptyState message="No form fields." />;
  }
  return (
    <dl className="space-y-2 overflow-auto p-3 font-mono-ui text-xs">
      {fields.map((field, index) => {
        const isFile = 'filename' in field && field.filename !== undefined;
        return (
          <div key={index} className="flex gap-2">
            <dt className="w-40 shrink-0 break-all text-[var(--muted)]">{field.name}</dt>
            <dd className="min-w-0 break-all">
              {isFile
                ? `File: ${field.filename} (${field.contentType ?? 'unknown type'})`
                : field.value || <span className="text-[var(--muted)]">(empty)</span>}
            </dd>
          </div>
        );
      })}
    </dl>
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
