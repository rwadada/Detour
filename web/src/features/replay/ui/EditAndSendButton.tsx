import { Send, SquarePen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useExchangeStore } from '@/entities/exchange';
import type { CapturedExchange } from '@/shared/api';
import { Button, Dialog, Input } from '@/shared/ui';
import { buildReplayOverrides, draftFromExchange } from '../model/buildReplayOverrides';
import { useReplayStore } from '../model/store';

const textareaClass =
  'w-full resize-none rounded-md border border-[var(--border)] bg-[var(--background)] p-2 font-mono-ui text-xs ' +
  'placeholder:text-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

const labelClass = 'mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]';

function EditAndSendForm({ exchange, onDone }: { exchange: CapturedExchange; onDone: () => void }) {
  const replayEdited = useReplayStore((s) => s.replayEdited);
  const failure = useReplayStore((s) => s.failure);
  // Ids of the replays already sent from this exchange, as a stable string so the selector doesn't re-render on every new row.
  const replayIds = useExchangeStore((s) =>
    s.exchanges
      .filter((e) => e.replayOf === exchange.id)
      .map((e) => e.id)
      .join(','),
  );
  /** Set once Send is pressed: what existed at that moment, to tell this send's outcome from earlier ones. */
  const [sent, setSent] = useState<{ failureSeq: number; knownReplays: string } | null>(null);
  const initial = draftFromExchange(exchange);
  const [method, setMethod] = useState(initial.draft.method);
  const [url, setUrl] = useState(initial.draft.url);
  const [headersText, setHeadersText] = useState(initial.draft.headersText);
  const [bodyText, setBodyText] = useState(initial.draft.bodyText);

  const send = () => {
    setSent({ failureSeq: failure?.seq ?? 0, knownReplays: replayIds });
    replayEdited(exchange, buildReplayOverrides(exchange, { method, url, headersText, bodyText }));
  };

  // The request shows up as a new row the moment the server starts it, so that is the cue that it went out.
  const started = sent !== null && replayIds !== sent.knownReplays;
  useEffect(() => {
    if (started) onDone();
  }, [started, onDone]);
  const refusal = sent !== null && failure !== null && failure.seq > sent.failureSeq ? failure.message : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="w-28 font-mono-ui text-xs"
          placeholder="Method"
          aria-label="Method"
        />
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="flex-1 font-mono-ui text-xs"
          placeholder="https://host/path?query"
          aria-label="URL"
        />
      </div>

      <div className="flex flex-col">
        <label htmlFor="edit-send-headers" className={labelClass}>
          Headers{' '}
          <span className="font-normal normal-case">(one per line, "Name: value" — delete a line to drop it)</span>
        </label>
        <textarea
          id="edit-send-headers"
          value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          rows={7}
          spellCheck={false}
          className={textareaClass}
        />
      </div>

      <div className="flex flex-col">
        <label htmlFor="edit-send-body" className={labelClass}>
          Body
        </label>
        {initial.bodyEditable ? (
          <textarea
            id="edit-send-body"
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            rows={9}
            spellCheck={false}
            className={textareaClass}
          />
        ) : (
          <div className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs text-[var(--muted)]">
            {exchange.requestBodyTruncated
              ? 'The body was cut off when captured — editing it would send an incomplete body, so it is sent as captured.'
              : 'Binary or non-UTF-8 body — sent as captured.'}
          </div>
        )}
      </div>

      {refusal && (
        <p role="alert" className="rounded-md border border-[var(--status-5xx)] bg-[var(--status-5xx)]/10 p-2 text-xs">
          {refusal}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--muted)]">
          Sent directly from this machine (not back through the proxy). The result appears as a new row linked to this
          request. Detour's own ports are refused.
        </p>
        <Button onClick={send} disabled={sent !== null && refusal === null} className="shrink-0">
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {sent !== null && refusal === null ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  );
}

/** Opens an editable copy of a captured request — method, URL, headers, body — and sends it (issue #214's "Edit & Send"), shown in `InspectorPanel` next to the plain Replay button. */
export function EditAndSendButton({ exchange }: { exchange: CapturedExchange }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} title="Edit & send this request">
        <SquarePen className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Edit & Send">
        {/* Mounted only while open, so every opening starts from the captured request again. */}
        <EditAndSendForm exchange={exchange} onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
