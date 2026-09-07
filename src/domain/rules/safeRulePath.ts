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
  return resolved;
}
