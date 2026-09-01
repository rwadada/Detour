import { lazy, Suspense, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { BreakpointEditor } from '@/components/BreakpointEditor';
import { MethodBadge, StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn, formatBytes, formatDuration, headerRows, parseQueryParams } from '@/lib/utils';
import { useLogStore } from '@/store/useLogStore';

// CodeMirror (~500KB) is only needed once a user actually opens the Body
// tab — code-splitting it keeps the initial bundle (and first paint) small,
// which matters more here than usual since the table can be rendering
// thousands of rows on the same page.
const BodyViewer = lazy(() => import('@/components/BodyViewer').then((m) => ({ default: m.BodyViewer })));

export function InspectorPanel() {
  const exchanges = useLogStore((s) => s.exchanges);
  const selectedId = useLogStore((s) => s.selectedId);
  const select = useLogStore((s) => s.select);
  const pausedBreakpoints = useLogStore((s) => s.pausedBreakpoints);
  const exchange = useMemo(() => exchanges.find((e) => e.id === selectedId), [exchanges, selectedId]);

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
        <Button variant="ghost" size="icon" onClick={() => select(null)} title="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <Tabs defaultValue="headers" className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="px-3">
          <TabsTrigger value="headers">Headers</TabsTrigger>
          <TabsTrigger value="query">
            Query Params{queryParams.length > 0 ? ` (${queryParams.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="body">Body</TabsTrigger>
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
            responseBody={exchange.responseBody}
            responseBodySize={exchange.responseBodySize}
            responseBodyTruncated={exchange.responseBodyTruncated}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BodyTab(props: {
  requestBody?: string;
  requestBodySize: number;
  requestBodyTruncated?: boolean;
  responseBody?: string;
  responseBodySize: number;
  responseBodyTruncated?: boolean;
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
            />
          ) : (
            <BodyViewer
              body={props.responseBody}
              bodySize={props.responseBodySize}
              truncated={props.responseBodyTruncated}
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
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</h3>
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
