import readline from 'node:readline';
import type { DeviceChoice, DevicePicker } from '../../usecase/ports/devicePicker';

/**
 * Real `DevicePicker` (see that file's doc comment) — a plain numbered
 * `readline` prompt on the real terminal. Bails out to `undefined` (no
 * prompt attempted at all) whenever `process.stdin` isn't an interactive
 * TTY: a CI job, a piped/redirected invocation, or any other script driving
 * `detour setup` has nothing that could ever answer a prompt, and would
 * otherwise just hang forever waiting on stdin.
 */
export const readlineDevicePicker: DevicePicker = {
  async pick(choices: DeviceChoice[]): Promise<string | undefined> {
    if (!process.stdin.isTTY) return undefined;

    console.log('Multiple devices connected:');
    choices.forEach((choice, index) => {
      console.log(`  ${index + 1}. ${choice.label}`);
    });

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`Pick a device [1-${choices.length}]: `, resolve);
      });
      const index = Number(answer.trim()) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= choices.length) return undefined;
      return choices[index]!.serial;
    } finally {
      rl.close();
    }
  },
};
