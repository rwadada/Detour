import { describe, expect, it } from 'vitest';
import { classifyAttestationRun } from './attestation';

describe('classifyAttestationRun', () => {
  it('is verified on a clean exit', () => {
    expect(classifyAttestationRun({ exitCode: 0, output: '' })).toEqual({ kind: 'verified' });
  });

  it('skips — rather than fails — when gh is not installed', () => {
    expect(classifyAttestationRun({ exitCode: 'ENOENT', output: '' })).toMatchObject({
      kind: 'skipped',
      reason: expect.stringContaining('not installed'),
    });
  });

  it('skips when gh is signed out (exit 4), and says how to fix it', () => {
    expect(
      classifyAttestationRun({ exitCode: 4, output: 'To get started with GitHub CLI, please run: gh auth login' }),
    ).toMatchObject({
      kind: 'skipped',
      reason: expect.stringContaining('gh auth login'),
    });
  });

  it('fails when the tarball has no attestation (what a tampered one gets: HTTP 404, exit 1)', () => {
    const output =
      'Error: HTTP 404: Not Found (https://api.github.com/repos/rwadada/Detour/attestations/sha256:15970925…)';
    expect(classifyAttestationRun({ exitCode: 1, output })).toEqual({ kind: 'failed', detail: output });
  });

  it('fails on any other non-zero exit, including a network error — an unverifiable download is not let through because the check hiccuped', () => {
    expect(
      classifyAttestationRun({ exitCode: 1, output: 'Error: dial tcp: lookup api.github.com: no such host\n' }),
    ).toMatchObject({
      kind: 'failed',
      detail: 'Error: dial tcp: lookup api.github.com: no such host',
    });
    expect(classifyAttestationRun({ exitCode: 2, output: '' })).toEqual({
      kind: 'failed',
      detail: 'gh exited with code 2',
    });
  });
});
