import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './protocol';

/** The dashboard keeps a hand-maintained copy of the version (issue #209) — this fails the moment the two are changed separately. */
describe('PROTOCOL_VERSION', () => {
  it("matches the dashboard's copy in web/src/shared/api/protocol.ts", () => {
    const webSource = fs.readFileSync(path.resolve(__dirname, '../../../web/src/shared/api/protocol.ts'), 'utf8');
    const match = webSource.match(/export const PROTOCOL_VERSION = (\d+);/);
    expect(match, 'web protocol.ts must export PROTOCOL_VERSION').not.toBeNull();
    expect(Number(match![1])).toBe(PROTOCOL_VERSION);
  });
});
