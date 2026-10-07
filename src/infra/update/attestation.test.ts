import { describe, expect, it, vi } from 'vitest';
import type { AttestationResult } from '../../domain/update/attestation';
import { verifyDownloadBeforeUpgrade } from './attestation';

function setup(result: AttestationResult) {
  const calls: string[] = [];
  const deps = {
    fetchDownload: vi.fn(async () => void calls.push('fetch')),
    cachedDownloadPath: vi.fn(async () => {
      calls.push('path');
      return '/cache/abc--detour-2.1.0.tar.gz';
    }),
    verify: vi.fn(async (_file: string) => {
      calls.push('verify');
      return result;
    }),
    log: vi.fn(),
    warn: vi.fn(),
  };
  return { deps, calls };
}

describe('verifyDownloadBeforeUpgrade', () => {
  it('fetches, then verifies the file that was fetched, and says so when it passes', async () => {
    const { deps, calls } = setup({ kind: 'verified' });
    await verifyDownloadBeforeUpgrade(deps);
    expect(calls).toEqual(['fetch', 'path', 'verify']);
    expect(deps.verify).toHaveBeenCalledWith('/cache/abc--detour-2.1.0.tar.gz');
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Verified'));
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('refuses — throws, so nothing is installed and nothing running is stopped — when it does not verify', async () => {
    const { deps } = setup({ kind: 'failed', detail: 'Error: HTTP 404: Not Found' });
    await expect(verifyDownloadBeforeUpgrade(deps)).rejects.toThrow(
      /did not pass its build attestation check, so it was not installed/,
    );
    await expect(verifyDownloadBeforeUpgrade(deps)).rejects.toThrow('Error: HTTP 404: Not Found');
    expect(deps.log).not.toHaveBeenCalled();
  });

  it('goes on with a warning when the check could not run (no gh / signed out), as updates always did', async () => {
    const { deps } = setup({ kind: 'skipped', reason: 'the GitHub CLI (`gh`) is not installed' });
    await expect(verifyDownloadBeforeUpgrade(deps)).resolves.toBeUndefined();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringMatching(/not installed.*sha256 check only/));
  });

  it('does not swallow a failed download: no verification is attempted on a file that is not there', async () => {
    const { deps } = setup({ kind: 'verified' });
    deps.fetchDownload.mockRejectedValueOnce(new Error('`brew fetch` exited with code 1'));
    await expect(verifyDownloadBeforeUpgrade(deps)).rejects.toThrow('brew fetch');
    expect(deps.verify).not.toHaveBeenCalled();
  });
});
