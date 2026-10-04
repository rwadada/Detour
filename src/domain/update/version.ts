/** Parses `v1.6.1` / `1.6.1` / `1.6.1-rc.1` into its numeric core, or undefined when it isn't a dotted-number version. */
export function parseVersion(raw: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Strips a leading `v` (the release tag form) so versions compare and print uniformly. */
export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/, '');
}

/** Whether `candidate` is strictly newer than `current`. An unparseable version on either side is never "newer" — better to miss an update than to prompt for a bogus one. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}
