/** What `gh attestation verify` told us about a downloaded release tarball. */
export type AttestationResult =
  /** The tarball is the one this repo's release workflow built (GitHub Artifact Attestation, SLSA provenance). */
  | { kind: 'verified' }
  /** The check could not run at all — no `gh`, or `gh` is not signed in — so nothing was learned either way. */
  | { kind: 'skipped'; reason: string }
  /** `gh` ran and the tarball did not verify: no attestation for its digest, a different repo or workflow, a bad signature. */
  | { kind: 'failed'; detail: string };

/** `gh` exits with this when it needs `gh auth login` (or `GH_TOKEN`) first. */
const GH_EXIT_AUTH_REQUIRED = 4;

/**
 * Reads the outcome of one `gh attestation verify` run.
 *
 * Only "could not even ask" is let through: a missing `gh` (`exitCode` of
 * `'ENOENT'`) or a signed-out one. Everything else that is not a clean exit is
 * a failure — including a network error — because letting an unverifiable
 * download proceed whenever the check hiccups would make the check worthless
 * to anyone able to cause a hiccup. An update is cheap to retry.
 */
export function classifyAttestationRun(run: { exitCode: number | 'ENOENT'; output: string }): AttestationResult {
  if (run.exitCode === 0) return { kind: 'verified' };
  if (run.exitCode === 'ENOENT') {
    return { kind: 'skipped', reason: 'the GitHub CLI (`gh`) is not installed' };
  }
  if (run.exitCode === GH_EXIT_AUTH_REQUIRED) {
    return { kind: 'skipped', reason: 'the GitHub CLI (`gh`) is not signed in (run `gh auth login`)' };
  }
  return { kind: 'failed', detail: run.output.trim() || `gh exited with code ${run.exitCode}` };
}
