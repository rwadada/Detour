import { execFile } from 'node:child_process';
import { classifyAttestationRun, type AttestationResult } from '../../domain/update/attestation';

const REPO = 'rwadada/Detour';
const VERIFY_TIMEOUT_MS = 60_000;

/** An `execFile` error as the exit code `classifyAttestationRun` reads: `ENOENT` for a missing binary, the real code when there is one, else a generic failure. */
function exitCodeOf(err: Error | null): number | 'ENOENT' {
  if (err === null) return 0;
  const code = (err as { code?: unknown }).code;
  if (code === 'ENOENT') return 'ENOENT';
  return typeof code === 'number' ? code : 1;
}

/** Runs `gh attestation verify <file> --repo rwadada/Detour` (`gh` being the binary to run) and classifies the outcome (see `classifyAttestationRun`). */
export function verifyReleaseAttestation(filePath: string, gh = 'gh'): Promise<AttestationResult> {
  return new Promise((resolve) => {
    execFile(
      // Looked up on PATH only when no absolute path was given (see `brewUpgradeDetour`).
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- the user's own GitHub CLI; same trust as `brew` itself.
      gh,
      ['attestation', 'verify', filePath, '--repo', REPO],
      { timeout: VERIFY_TIMEOUT_MS },
      (err, stdout, stderr) => {
        resolve(classifyAttestationRun({ exitCode: exitCodeOf(err), output: `${stdout}${stderr}` }));
      },
    );
  });
}

export interface VerifyBeforeUpgradeDeps {
  /** Downloads the release the package manager is about to install (it checks the formula's sha256 itself). */
  fetchDownload(): Promise<void>;
  /** Where that download now sits on disk. */
  cachedDownloadPath(): Promise<string>;
  verify(filePath: string): Promise<AttestationResult>;
  log(message: string): void;
  warn(message: string): void;
}

/**
 * The step between "the tap says there is a new release" and "install it":
 * fetch the tarball Homebrew would install and check its build attestation,
 * so a tarball that did not come out of this repo's release workflow — a
 * swapped release asset, a tap pointing somewhere else — is refused rather
 * than installed and then trusted with the root CA key and decrypted traffic.
 *
 * Throws (so the caller leaves everything running as it was) when `gh` ran and
 * the tarball did not verify. When `gh` is missing or signed out nothing could
 * be learned, so the update goes on as it always did, with a warning.
 */
export async function verifyDownloadBeforeUpgrade(deps: VerifyBeforeUpgradeDeps): Promise<void> {
  await deps.fetchDownload();
  const result = await deps.verify(await deps.cachedDownloadPath());
  if (result.kind === 'verified') {
    deps.log('✔ Verified the release download against its GitHub build attestation.');
  } else if (result.kind === 'skipped') {
    deps.warn(
      `Could not verify the release download's build attestation: ${result.reason}. Continuing with Homebrew's sha256 check only.`,
    );
  } else {
    throw new Error(
      `The release download did not pass its build attestation check, so it was not installed:\n${result.detail}\nNothing was changed and running instances were left as they were. Try again; if it keeps failing, do not update and report it (see SECURITY.md).`,
    );
  }
}
