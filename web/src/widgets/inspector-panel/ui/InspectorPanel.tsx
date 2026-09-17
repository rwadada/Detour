import { lazy, Suspense, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { isPassthroughDone, MethodBadge, StatusBadge, useExchangeStore } from '@/entities/exchange';
import { isGrpcContentType, parseGrpcPath } from '@/entities/grpc';
import { BreakpointEditor, useBreakpointResumeStore } from '@/features/breakpoint-resume';
import { CopyAsCurlButton } from '@/features/copy-as-curl';
import { ReplayButton } from '@/features/replay';
import {
  cn,
  findHeaderValue,
  formatBytes,
  formatDuration,
  headerRows,
  headerRowsToText,
  parseQueryParams,
} from '@/shared/lib/utils';
import { Button, CopyIconButton, Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui';
import { CreateRuleButton } from './CreateRuleButton';
import { TimingWaterfall } from './TimingWaterfall';

// CodeMirror (~500KB) is only needed once a user actually opens the Body
// tab — code-splitting it keeps the initial bundle (and first paint) small,
// which matters more here than usual since the table can be rendering
// thousands of rows on the same page.
const BodyViewer = lazy(() => import('./BodyViewer').then((m) => ({ default: m.BodyViewer })));

export function InspectorPanel() {
  const exchanges = useExchangeStore((s) => s.exchanges);
  const selectedId = useExchangeStore((s) => s.selectedId);
  const select = useExchangeStore((s) => s.select);
  const pausedBreakpoints = useBreakpointResumeStore((s) => s.pausedBreakpoints);
  const exchange = useMemo(() => exchanges.find((e) => e.id === selectedId), [exchanges, selectedId]);
  // Detects a gRPC call from its request `content-type` (the actual
  // protocol negotiation — gRPC has no such thing per-direction, so this
  // one result covers both the Body tab's Request and Response views) and
  // its URL path (`/{service}/{method}`, gRPC's own fixed convention).
  // `undefined` for anything else — the Body tab then falls back to its
  // normal text/JSON rendering, same as before this feature existed.
  // Computed here, unconditionally, rather than inside the `!exchange`
  // check below: every hook in this component must run every render
  // regardless of `exchange`'s own presence (Rules of Hooks), so the guard
  // moves inside the memo callback instead.
  const grpcCall = useMemo(() => {
    if (!exchange) return undefined;
    if (!isGrpcContentType(findHeaderValue(exchange.requestHeaders, 'content-type'))) return undefined;
    try {
      return parseGrpcPath(new URL(exchange.url).pathname);
    } catch {
      return undefined;
    }
  }, [exchange]);

  if (!exchange) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-[var(--muted)]">
        Select a request to inspect its headers, query params, and body.
      </div>
    );
  }

  // A `breakpoint` rule paused this exchange — edit/resume/abort it instead
  // of the normal read-only inspector, since it can't be inspected any
  // further until it's let through (or dropped) one way or another.
  const pausedPayload = pausedBreakpoints[exchange.id];
  if (pausedPayload) {
    return <BreakpointEditor payload={pausedPayload} />;
  }

  // A raw TLS passthrough tunnel (see `CapturedExchange.passthrough`) — its
  // headers/query/body tabs below would just render empty placeholders, no
  // more informative than not showing them at all, and "Copy as cURL"/
  // Replay make no sense for a connection that was never actually parsed as
  // HTTP. Explain why instead of a blank inspector that looks broken.
  if (exchange.passthrough) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <MethodBadge method={exchange.method} />
              <StatusBadge
                status={exchange.statusCode}
                error={exchange.error}
                passthrough={isPassthroughDone(exchange)}
              />
            </div>
            <p className="mt-1 break-all font-mono-ui text-xs text-[var(--muted)]">{exchange.url}</p>
            <p className="mt-1 text-xs text-[var(--muted)]">{formatDuration(exchange.durationMs)}</p>
            {exchange.error && <p className="mt-1 text-xs text-[var(--status-5xx)]">{exchange.error}</p>}
          </div>
          <Button variant="ghost" size="icon" onClick={() => select(null)} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-[var(--muted)]">
          Encrypted TLS passthrough — Intercept is off (or this host is outside Focus), so the tunnel was relayed
          byte-for-byte without being decrypted. Headers and body aren't observable this way; turn Intercept back on (or
          add this host to Focus) to inspect requests through it.
        </div>
      </div>
    );
  }

  const queryParams = parseQueryParams(exchange.url);
  const requestHeaders = headerRows(exchange.requestHeaders);
  const responseHeaders = headerRows(exchange.responseHeaders);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <MethodBadge method={exchange.method} />
            <StatusBadge status={exchange.statusCode} error={exchange.error} />
            {exchange.ruleName && (
              <span className="rounded bg-[var(--row-hover)] px-1.5 py-0.5 text-xs text-[var(--muted)]">
                rule: {exchange.ruleName}
              </span>
            )}
          </div>
          <p className="mt-1 break-all font-mono-ui text-xs text-[var(--muted)]">{exchange.url}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {formatDuration(exchange.durationMs)} · req {formatBytes(exchange.requestBodySize)} · res{' '}
            {formatBytes(exchange.responseBodySize)}
          </p>
          {exchange.error && <p className="mt-1 text-xs text-[var(--status-5xx)]">{exchange.error}</p>}
        </div>
        <div className="flex shrink-0 items-center">
          <CopyAsCurlButton exchange={exchange} />
          <ReplayButton exchange={exchange} />
          <CreateRuleButton exchange={exchange} />
          <Button variant="ghost" size="icon" onClick={() => select(null)} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Tabs defaultValue="headers" className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="px-3">
          <TabsTrigger value="headers">Headers</TabsTrigger>
          <TabsTrigger value="query">
            Query Params{queryParams.length > 0 ? ` (${queryParams.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="body">Body</TabsTrigger>
          <TabsTrigger value="timing">Timing</TabsTrigger>
        </TabsList>

        <TabsContent value="headers" className="p-3">
          <HeaderSection title="Request Headers" rows={requestHeaders} />
          <HeaderSection title="Response Headers" rows={responseHeaders} />
        </TabsContent>

        <TabsContent value="query" className="p-3">
          {queryParams.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">No query parameters.</p>
          ) : (
            <KeyValueTable rows={queryParams} />
          )}
        </TabsContent>

        <TabsContent value="body" className="flex flex-col overflow-hidden">
          <BodyTab
            requestBody={exchange.requestBody}
            requestBodySize={exchange.requestBodySize}
            requestBodyTruncated={exchange.requestBodyTruncated}
            requestContentEncoding={findHeaderValue(exchange.requestHeaders, 'content-encoding')}
            responseBody={exchange.responseBody}
            responseBodySize={exchange.responseBodySize}
            responseBodyTruncated={exchange.responseBodyTruncated}
            responseContentEncoding={findHeaderValue(exchange.responseHeaders, 'content-encoding')}
            grpcCall={grpcCall}
            requestGrpcEncoding={findHeaderValue(exchange.requestHeaders, 'grpc-encoding')}
            responseGrpcEncoding={findHeaderValue(exchange.responseHeaders, 'grpc-encoding')}
          />
        </TabsContent>

        <TabsContent value="timing" className="overflow-auto">
          <TimingWaterfall timing={exchange.timing} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BodyTab(props: {
  requestBody?: string;
  requestBodySize: number;
  requestBodyTruncated?: boolean;
  requestContentEncoding?: string;
  responseBody?: string;
  responseBodySize: number;
  responseBodyTruncated?: boolean;
  responseContentEncoding?: string;
  /** Set when the request's `content-type` and URL identify this exchange as a gRPC call (issue #18's dashboard follow-up) — see `InspectorPanel`'s own `grpcCall` doc comment. Passed through to both `BodyViewer`s below; which of `requestType`/`responseType` it resolves to differs, but the RPC it names doesn't. */
  grpcCall?: { service: string; method: string };
  requestGrpcEncoding?: string;
  responseGrpcEncoding?: string;
}) {
  const [which, setWhich] = useState<'request' | 'response'>(props.responseBodySize > 0 ? 'response' : 'request');

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex gap-1 border-b border-[var(--border)] px-3 py-1.5">
        {(['request', 'response'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setWhich(tab)}
            className={cn(
              'rounded px-2 py-0.5 text-xs font-medium capitalize',
              which === tab
                ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                : 'text-[var(--muted)] hover:bg-[var(--row-hover)]',
            )}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<div className="p-3 text-xs text-[var(--muted)]">Loading…</div>}>
          {which === 'request' ? (
            <BodyViewer
              body={props.requestBody}
              bodySize={props.requestBodySize}
              truncated={props.requestBodyTruncated}
              contentEncoding={props.requestContentEncoding}
              grpcCall={props.grpcCall}
              // Only set alongside `grpcCall` (never on its own) — `BodyViewer`/
              // `useGrpcDecode`'s own doc comments assume the two are either
              // both set or both undefined (a Copilot review on PR #127 caught
              // this passing "request" unconditionally, gRPC call or not).
              grpcDirection={props.grpcCall ? 'request' : undefined}
              grpcEncoding={props.requestGrpcEncoding}
            />
          ) : (
            <BodyViewer
              body={props.responseBody}
              bodySize={props.responseBodySize}
              truncated={props.responseBodyTruncated}
              contentEncoding={props.responseContentEncoding}
              grpcCall={props.grpcCall}
              grpcDirection={props.grpcCall ? 'response' : undefined}
              grpcEncoding={props.responseGrpcEncoding}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}

function HeaderSection({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</h3>
        {rows.length > 0 && (
          <CopyIconButton
            getText={() => headerRowsToText(rows)}
            title={`Copy ${title.toLowerCase()}`}
            className="h-5 w-5"
          />
        )}
      </div>
      {rows.length === 0 ? <p className="text-xs text-[var(--muted)]">None.</p> : <KeyValueTable rows={rows} />}
    </div>
  );
}

function KeyValueTable({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="space-y-1 font-mono-ui text-xs">
      {rows.map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <dt className="w-40 shrink-0 break-all text-[var(--muted)]">{key}</dt>
          <dd className="min-w-0 break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
