import readline from 'node:readline';
import type { DeviceChoice, DevicePicker } from '../../usecase/ports/devicePicker';

/**
 * Real `DevicePicker` (see that file's doc comment) — a plain numbered
 * `readline` prompt on the real terminal. `isInteractive()` is `false`
 * whenever `process.stdin` isn't an interactive TTY: a CI job, a
 * piped/redirected invocation, or any other script driving `detour setup`
 * has nothing that could ever answer a prompt, and `pick()` would otherwise
 * just hang forever waiting on stdin.
 */
export const readlineDevicePicker: DevicePicker = {
  isInteractive(): boolean {
    return Boolean(process.stdin.isTTY);
  },

  async pick(choices: DeviceChoice[]): Promise<string | undefined> {
    console.log('Multiple devices connected:');
    choices.forEach((choice, index) => {
      console.log(`  ${index + 1}. ${choice.label}`);
    });

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      // Re-prompts on anything but a valid number — `android.ts` only ever
      // calls `pick()` after `isInteractive()` already said this terminal
      // *can* prompt, so a typo or an out-of-range answer is a mistake to
      // correct, not "can't prompt", which `undefined` is reserved for
      // elsewhere in this port (see `DevicePicker`'s doc comment) —
      // returning it here instead would make `requireOneDevice` report its
      // non-interactive-environment message for what's actually just a
      // fixable typo.
      for (;;) {
        const answer = (
          await new Promise<string>((resolve) => rl.question(`Pick a device [1-${choices.length}]: `, resolve))
        ).trim();
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index]!.serial;
        console.log(`"${answer}" isn't a valid choice — enter a number from 1 to ${choices.length}.`);
      }
    } finally {
      rl.close();
    }
  },
};
