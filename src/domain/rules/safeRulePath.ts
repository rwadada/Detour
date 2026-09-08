import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves a rules.json-relative path (`script.path`/`mock.bodyFile`)
 * against `basePath` (the directory rules.json lives in) and rejects
 * anything that escapes it — an absolute path, `../` traversal, etc. —
 * unless `allowExternal` is set (issue #98's `--allow-external-script-paths`
 * opt-in, off by default). Mirrors the traversal guard `staticServer.ts`
 * uses for the dashboard's static files.
 *
 * Without this, a `rules.json` writable by anything reaching the
 * dashboard's `setRules` (issue #92) could point `script.path` at an
 * arbitrary local `.js` file — arbitrary code execution with detour's own
 * process permissions — or `mock.bodyFile` at an arbitrary local file (e.g.
 * `~/.detour/certs/keys/ca.private.key`) and read its contents back as a
 * response body.
 */
export function resolveRulePath(
  basePath: string,
  relativePath: string,
  fieldLabel: string,
  allowExternal: boolean,
): string {
  const root = path.resolve(basePath);
  const resolved = path.resolve(root, relativePath);
  if (allowExternal) return resolved;
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `${fieldLabel} "${relativePath}" resolves outside of the rules.json directory ("${root}") — refusing to use it. ` +
        'Pass --allow-external-script-paths to `detour start` to allow paths outside this directory.',
    );
  }
  // The lexical check above isn't enough on its own: `resolved` (or a
  // directory between it and `root`) can be a symlink that *on disk* points
  // somewhere outside `root` even though the path string itself never
  // wrote a `..`. Both `fs.readFileSync` (mock.bodyFile) and `require()`
  // (script.path) follow symlinks, so that would silently defeat the
  // containment check above. `fs.realpathSync` resolves every symlink in
  // the chain (the final component and any ancestor directory), so
  // comparing the *real* paths catches this the lexical check can't.
  let realResolved: string;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    // Doesn't exist (yet), or some other unresolvable path — nothing to
    // escape through via a symlink; the actual read/require call this
    // feeds into will raise its own not-found error.
    return resolved;
  }
  const realRoot = fs.realpathSync(root);
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
    throw new Error(
      `${fieldLabel} "${relativePath}" resolves (via a symlink) outside of the rules.json directory ("${root}") — refusing to use it. ` +
        'Pass --allow-external-script-paths to `detour start` to allow paths outside this directory.',
    );
  }
  // A directory (or any other non-regular-file: a socket, a device, ...)
  // passing containment isn't enough on its own for `script.path`:
  // `scriptModuleLoader.ts` ultimately calls `require()` on this value, and
  // `require(someDir)` follows `someDir/package.json`'s "main" field —
  // which can itself point anywhere, including outside `root` entirely
  // (e.g. `"main": "../../../etc/passwd"`), bypassing containment even
  // though `someDir` itself checked out. `mock.bodyFile` never legitimately
  // names a directory either (reading one throws EISDIR), so rejecting
  // early here applies to both actions without needing to special-case one.
  if (!fs.statSync(realResolved).isFile()) {
    // Not necessarily a directory specifically — a socket, device, FIFO,
    // etc. would also fail `isFile()` — so the message describes the actual
    // condition checked rather than naming one particular non-file kind.
    throw new Error(
      `${fieldLabel} "${relativePath}" does not resolve to a regular file ("${resolved}") — refusing to use it ` +
        '(a directory\'s own package.json "main" could point outside the rules.json directory, for example).',
    );
  }
  return resolved;
}
