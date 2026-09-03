import type { CapturedExchange, HeaderMap } from '@/shared/api';
import { decodeCapturedBody, headerRows } from '@/shared/lib/utils';

export type DiffStatus = 'same' | 'added' | 'removed' | 'changed';

export interface HeaderDiffRow {
  name: string;
  a?: string;
  b?: string;
  status: DiffStatus;
}

function headerStatus(a: string | undefined, b: string | undefined): DiffStatus {
  if (a === undefined && b !== undefined) return 'added';
  if (a !== undefined && b === undefined) return 'removed';
  return a === b ? 'same' : 'changed';
}

/** Diffs two header maps by name, sorted alphabetically. `a`/`b` name which side is "before"/"after" only for the added/removed labels — neither is privileged otherwise. */
export function diffHeaders(a: HeaderMap | undefined, b: HeaderMap | undefined): HeaderDiffRow[] {
  const aRows = new Map(headerRows(a));
  const bRows = new Map(headerRows(b));
  const names = Array.from(new Set([...aRows.keys(), ...bRows.keys()])).sort((x, y) => x.localeCompare(y));
  return names.map((name) => {
    const av = aRows.get(name);
    const bv = bRows.get(name);
    return { name, a: av, b: bv, status: headerStatus(av, bv) };
  });
}

export interface BodyDiffLine {
  a?: string;
  b?: string;
  same: boolean;
}

/**
 * A line-by-line comparison of two decoded bodies, index-aligned. This is a
 * simplification, not a true LCS/Myers diff: a single inserted or deleted
 * line shifts every line after it, so the rest of the body shows as
 * "changed" even where the content is identical shifted by one line. Good
 * enough for spotting a mock/rewrite's effect on an otherwise-similar
 * response; a proper diff algorithm is future work if that turns out to
 * matter in practice.
 */
export function diffBodyLines(aText: string | undefined, bText: string | undefined): BodyDiffLine[] {
  const aLines = aText !== undefined ? aText.split('\n') : [];
  const bLines = bText !== undefined ? bText.split('\n') : [];
  const max = Math.max(aLines.length, bLines.length);
  const rows: BodyDiffLine[] = [];
  for (let i = 0; i < max; i += 1) {
    const a = aLines[i];
    const b = bLines[i];
    rows.push({ a, b, same: a === b });
  }
  return rows;
}

/** Decodes a captured body to text for diffing, `undefined` for an absent or binary/non-UTF-8 body. */
export function decodeForDiff(body: string | undefined): string | undefined {
  return body !== undefined ? decodeCapturedBody(body) : undefined;
}

export interface ExchangeDiff {
  headers: { request: HeaderDiffRow[]; response: HeaderDiffRow[] };
  requestBody: BodyDiffLine[];
  responseBody: BodyDiffLine[];
}

export function diffExchanges(a: CapturedExchange, b: CapturedExchange): ExchangeDiff {
  return {
    headers: {
      request: diffHeaders(a.requestHeaders, b.requestHeaders),
      response: diffHeaders(a.responseHeaders, b.responseHeaders),
    },
    requestBody: diffBodyLines(decodeForDiff(a.requestBody), decodeForDiff(b.requestBody)),
    responseBody: diffBodyLines(decodeForDiff(a.responseBody), decodeForDiff(b.responseBody)),
  };
}
