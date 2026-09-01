import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { decodeCapturedBody, encodeBodyToBase64, headersToEditableText, parseEditableHeaders } from '@/lib/utils';
import { useLogStore } from '@/store/useLogStore';
import type { BreakpointPayload } from '@/types';

const textareaClass =
  'w-full flex-1 resize-none rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 font-mono-ui text-xs ' +
  'placeholder:text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

/**
 * Shown in the inspector for an exchange currently paused by a `breakpoint`
 * rule. Lets the request (method/path/headers/body) or response
 * (status/headers/body) be edited before resuming, or aborted outright.
 */
export function BreakpointEditor({ payload }: { payload: BreakpointPayload }) {
  const resumeBreakpointRequest = useLogStore((s) => s.resumeBreakpointRequest);
  const resumeBreakpointResponse = useLogStore((s) => s.resumeBreakpointResponse);
  const abortBreakpoint = useLogStore((s) => s.abortBreakpoint);

  const decodedBody = payload.body !== undefined ? decodeCapturedBody(payload.body) : '';
  const bodyEditable = decodedBody !== undefined && !payload.bodyTruncated;

  const [method, setMethod] = useState(payload.phase === 'request' ? payload.method : '');
  const [path, setPath] = useState(payload.phase === 'request' ? payload.path : '');
  const [status, setStatus] = useState(payload.phase === 'response' ? String(payload.status) : '');
  const [statusMessage, setStatusMessage] = useState(payload.phase === 'response' ? (payload.statusMessage ?? '') : '');
  const [headersText, setHeadersText] = useState(headersToEditableText(payload.headers));
  const [bodyText, setBodyText] = useState(decodedBody ?? '');

  const resume = () => {
    const headers = parseEditableHeaders(headersText);
    const body = bodyEditable ? encodeBodyToBase64(bodyText) : undefined;
    if (payload.phase === 'request') {
      resumeBreakpointRequest(payload.id, {
        method: method.trim() || undefined,
        path: path.trim() || undefined,
        headers,
        body,
      });
    } else {
      const parsedStatus = Number.parseInt(status, 10);
      resumeBreakpointResponse(payload.id, {
        status: Number.isFinite(parsedStatus) ? parsedStatus : undefined,
        statusMessage: statusMessage.trim() || undefined,
        headers,
        body,
      });
    }
  };

  const abort = () => abortBreakpoint(payload.id, payload.phase);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--row-hover)] px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--status-3xx)]" />
          Paused — editing the {payload.phase === 'request' ? 'outgoing request' : 'incoming response'}
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={abort}>
            Abort
          </Button>
          <Button size="sm" onClick={resume}>
            Resume
          </Button>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-auto p-3">
        {payload.phase === 'request' ? (
          <div className="flex gap-2">
            <Input
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="w-24 font-mono-ui text-xs"
              placeholder="Method"
            />
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="flex-1 font-mono-ui text-xs"
              placeholder="/path?query"
            />
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-20 font-mono-ui text-xs"
              placeholder="Status"
            />
            <Input
              value={statusMessage}
              onChange={(e) => setStatusMessage(e.target.value)}
              className="flex-1 font-mono-ui text-xs"
              placeholder="Status message (optional)"
            />
          </div>
        )}

        <div className="flex flex-col">
          <label className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Headers <span className="normal-case font-normal">(one per line, "Name: value")</span>
          </label>
          <textarea
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            rows={6}
            spellCheck={false}
            className={textareaClass}
          />
        </div>

        <div className="flex flex-1 flex-col">
          <label className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Body</label>
          {bodyEditable ? (
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              spellCheck={false}
              className={textareaClass}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--panel)] p-3 text-center text-xs text-[var(--muted)]">
              {payload.bodyTruncated
                ? 'Body was truncated when captured — editing it here would send an incomplete body, so it will be forwarded unchanged.'
                : 'Binary or non-UTF-8 body — will be forwarded unchanged.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
