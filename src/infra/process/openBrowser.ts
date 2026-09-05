import { spawn } from 'node:child_process';

/**
 * Opens `url` in the user's default browser (issue #3 follow-up: `detour
 * start` used to print the dashboard URL and leave the user to copy/paste
 * it — this fires it open automatically). No dependency on the `open` npm
 * package: three platforms, three well-known one-liners, so a tiny wrapper
 * around `child_process.spawn` covers it without adding a dependency.
 *
 * Best-effort only — a missing `xdg-open` in a headless/minimal Linux
 * environment (or any other launch failure) is logged as a warning and
 * otherwise ignored. The dashboard server is already listening at this
 * point regardless; failing to auto-open it must never take the proxy or
 * dashboard down, nor block `runStartBody`'s caller.
 */
export function openBrowser(url: string): void {
  const { command, args } = browserCommandFor(process.platform, url);
  try {
    // `detached: true` + `unref()`: the browser launcher (`open`/`start`/
    // `xdg-open`) shouldn't be a child detour has to wait on or clean up —
    // once it's spawned, its lifetime is entirely up to the OS.
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      console.warn(`⚠ Couldn't open the dashboard in a browser automatically: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    console.warn(
      `⚠ Couldn't open the dashboard in a browser automatically: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Exported for unit testing — the platform-to-command mapping is the only part of `openBrowser` worth testing directly (spawning a real browser isn't). */
export function browserCommandFor(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      // `cmd /c start "" <url>`: `start`'s first quoted argument is taken as
      // the new window's title, so an empty one is required — passing the
      // URL there directly makes `start` treat it as the title instead of
      // something to open when the URL contains characters like `&`.
      return { command: 'cmd', args: ['/c', 'start', '""', url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
}
