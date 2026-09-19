import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolves what `NODE_EXTRA_CA_CERTS` should be for the command under test.
 * If the parent process (or its own environment) already has one set, that
 * bundle is trusted for a real reason — overwriting it with just detour's
 * own CA would silently drop that trust for the command's whole run. Node
 * only ever reads `NODE_EXTRA_CA_CERTS` as a single file, so the two are
 * concatenated into a fresh temp file instead of simply picking one; the
 * caller is responsible for deleting it (`cleanup`) once the command exits.
 */
export function resolveCaCertsForCommand(caCertPath: string): { path: string; cleanup: () => void } {
  const existing = process.env.NODE_EXTRA_CA_CERTS;
  if (!existing) return { path: caCertPath, cleanup: () => {} };
  let existingContents: string;
  try {
    existingContents = fs.readFileSync(existing, 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read the existing NODE_EXTRA_CA_CERTS bundle to merge it with detour's own CA: ${existing}\n  ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  // `mkdtempSync` (not a predictable `<tmpdir>/detour-test-ca-<pid>-<ts>.pem`
  // path built by hand) gets a securely, atomically created, uniquely-named
  // directory from the OS — on a shared multi-user machine, a hand-built
  // path is guessable ahead of time, letting another user pre-create a
  // symlink there that a plain `writeFileSync` would happily follow.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-test-ca-'));
  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort — a leftover temp dir in the OS tmp dir is harmless.
    }
  };

  const combinedPath = path.join(tmpDir, 'combined-ca.pem');
  try {
    // `wx`: fails instead of following a pre-existing path (symlink or
    // otherwise) at `combinedPath` — belt-and-suspenders alongside `mkdtemp`
    // already giving this directory a name nothing else could have guessed.
    fs.writeFileSync(combinedPath, `${existingContents}\n${fs.readFileSync(caCertPath, 'utf8')}`, { flag: 'wx' });
  } catch (err) {
    // The directory exists by this point but the caller never receives
    // `cleanup`, so a failure here (an unreadable CA cert, a full disk)
    // would strand it in the OS temp dir with nobody left holding its name.
    cleanup();
    throw err;
  }
  return { path: combinedPath, cleanup };
}

/** Runs `command` with the proxy env vars set, resolving with its exit code (or 1, if it was killed by a signal instead of exiting normally). */
export function runCommandUnderProxy(command: string[], proxyUrl: string, caCertPath: string): Promise<number> {
  const [cmd, ...args] = command;
  const { path: nodeExtraCaCerts, cleanup } = resolveCaCertsForCommand(caCertPath);
  // Stripped, not just left alone: many CI/dev environments already set
  // NO_PROXY/no_proxy to something like "localhost,127.0.0.1" for their own
  // reasons, which — inherited unchanged here — would make a proxy-aware
  // HTTP client under test bypass detour entirely for exactly the hosts a
  // local test run is most likely to hit, silently capturing zero exchanges
  // rather than failing loudly.
  const envWithoutNoProxy = { ...process.env };
  delete envWithoutNoProxy.NO_PROXY;
  delete envWithoutNoProxy.no_proxy;
  return new Promise<number>((resolve, reject) => {
    // `spawn()` reports most failures (bad command, ENOENT) asynchronously
    // via the 'error' event below, but it can also throw synchronously for
    // a handful of argument-validation failures — a try/catch here is what
    // makes `cleanup()` (deleting the temp CA-bundle directory) run on that
    // path too, instead of only on the two async outcomes.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd!, args, {
        stdio: 'inherit',
        env: {
          ...envWithoutNoProxy,
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          // Lets a Node-based command under test (npm test, playwright, …)
          // trust the MITM'd HTTPS connections without a manual `detour
          // cert export`/trust step of its own.
          NODE_EXTRA_CA_CERTS: nodeExtraCaCerts,
        },
      });
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
