import type { CapturedExchange, ReplayOverrides } from '@/shared/api';
import {
  decodeCapturedBody,
  encodeBodyToBase64,
  headerRows,
  headerRowsToText,
  parseEditableHeaders,
} from '@/shared/lib/utils';

/** What the Edit & Send form holds while the user is editing. */
export interface ReplayDraft {
  method: string;
  url: string;
  headersText: string;
  bodyText: string;
}

/** The form's starting values, from the captured exchange. `bodyEditable` is false for a body that is binary or was cut off at capture — editing that would send something other than what was recorded, so it is left alone. */
export function draftFromExchange(exchange: CapturedExchange): { draft: ReplayDraft; bodyEditable: boolean } {
  const decoded = exchange.requestBody === undefined ? '' : decodeCapturedBody(exchange.requestBody);
  return {
    draft: {
      method: exchange.method,
      url: exchange.url,
      headersText: headerRowsToText(headerRows(exchange.requestHeaders)),
      bodyText: decoded ?? '',
    },
    bodyEditable: decoded !== undefined && !exchange.requestBodyTruncated,
  };
}

/**
 * Turns the edited form into the `overrides` the server expects — only the
 * fields that actually differ from the original. An untouched field is left
 * out so the server keeps the exact captured value (the original bytes of a
 * body, headers that the text form can't round-trip byte-for-byte, …).
 */
export function buildReplayOverrides(exchange: CapturedExchange, draft: ReplayDraft): ReplayOverrides {
  const initial = draftFromExchange(exchange);
  const overrides: ReplayOverrides = {};
  const method = draft.method.trim();
  if (method && method !== exchange.method) overrides.method = method;
  const url = draft.url.trim();
  if (url && url !== exchange.url) overrides.url = url;
  if (draft.headersText.trim() !== initial.draft.headersText.trim()) {
    overrides.headers = parseEditableHeaders(draft.headersText);
  }
  if (initial.bodyEditable && draft.bodyText !== initial.draft.bodyText) {
    overrides.body = encodeBodyToBase64(draft.bodyText);
  }
  return overrides;
}
