import readline from 'node:readline';
import type { DeviceChoice, DevicePicker } from '../../usecase/ports/devicePicker';

/**
 * Repeatedly asks `rl` to pick a number from `1` to `choiceCount`, resolving
 * to the chosen (0-based) index — or `undefined` if `rl` closes before a
 * valid one is ever given (see the loop's own comment for why that's a
 * real possibility, not just a defensive-programming nicety). Split out
 * from `pick()` below purely so this can be unit tested against a `readline`
 * interface built on a fake stream instead of a real `process.stdin`.
 */
export async function promptForChoiceIndex(rl: readline.Interface, choiceCount: number): Promise<number | undefined> {
  for (;;) {
    // `rl.question`'s callback only ever fires once a full line has
    // actually been read — if stdin closes mid-prompt instead (piped input
    // running out, the terminal disconnecting), that callback never fires
    // at all, and this would hang forever waiting on it. `rl`'s own `close`
    // event *does* still fire in that case, so race it against the
    // question and resolve to `undefined` — the "can't prompt any further"
    // outcome `DevicePicker.pick()`'s contract already has a meaning for —
    // rather than hanging.
    const answer = await new Promise<string | undefined>((resolve) => {
      const onClose = () => resolve(undefined);
      rl.once('close', onClose);
      rl.question(`Pick a device [1-${choiceCount}]: `, (line) => {
        rl.off('close', onClose);
        resolve(line);
      });
    });
    if (answer === undefined) return undefined;
    const trimmed = answer.trim();
    const index = Number(trimmed) - 1;
    // Re-prompts on anything but a valid number — `android.ts` only ever
    // calls `pick()` after `isInteractive()` already said this terminal
    // *can* prompt, so a typo or an out-of-range answer is a mistake to
    // correct, not "can't prompt", which `undefined` is reserved for
    // elsewhere in this port (see `DevicePicker`'s doc comment) —
    // returning it here instead would make `requireOneDevice` report its
    // non-interactive-environment message for what's actually just a
    // fixable typo.
    if (Number.isInteger(index) && index >= 0 && index < choiceCount) return index;
    console.log(`"${trimmed}" isn't a valid choice — enter a number from 1 to ${choiceCount}.`);
  }
}

/**
 * Real `DevicePicker` (see that file's doc comment) — a plain numbered
 * `readline` prompt on the real terminal. `isInteractive()` is `false`
 * whenever *either* `process.stdin` or `process.stdout` isn't an
 * interactive TTY: stdin alone isn't enough — `detour doctor > out.txt`
 * (stdout redirected to a file, stdin still the real terminal) would still
 * pass a stdin-only check, but the prompt and numbered menu `pick()` prints
 * go straight into that file where nobody's watching, leaving whoever's
 * running it looking at what appears to be a hung command while it waits
 * on an answer to a question they never saw.
 */
export const readlineDevicePicker: DevicePicker = {
  isInteractive(): boolean {
    return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  },

  async pick(choices: DeviceChoice[]): Promise<string | undefined> {
    console.log('Multiple devices connected:');
    choices.forEach((choice, index) => {
      console.log(`  ${index + 1}. ${choice.label}`);
    });

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const index = await promptForChoiceIndex(rl, choices.length);
      return index === undefined ? undefined : choices[index]!.serial;
    } finally {
      rl.close();
    }
  },
};
