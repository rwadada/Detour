import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { promptForChoiceIndex, readlineDevicePicker } from './readlineDevicePicker';

/** A `readline.Interface` over fake, in-memory streams — no real terminal/`process.stdin` involved, so a test can write/close the input on its own schedule. */
function fakeReadlineInterface(): { rl: readline.Interface; input: PassThrough } {
  const input = new PassThrough();
  const output = new PassThrough();
  output.on('data', () => {}); // drain silently — this file doesn't assert on prompt text
  return { rl: readline.createInterface({ input, output }), input };
}

describe('readlineDevicePicker.isInteractive', () => {
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  afterEach(() => {
    process.stdin.isTTY = originalStdinIsTTY;
    process.stdout.isTTY = originalStdoutIsTTY;
  });

  it('is true only when both stdin and stdout are TTYs', () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    expect(readlineDevicePicker.isInteractive()).toBe(true);
  });

  it("is false when stdin isn't a TTY, even if stdout is", () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = true;
    expect(readlineDevicePicker.isInteractive()).toBe(false);
  });

  it("is false when stdout isn't a TTY (redirected to a file, say), even if stdin still is — otherwise the prompt/menu pick() prints would go somewhere nobody's watching, looking like a hang while it waits on an answer to a question no one ever saw", () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = false;
    expect(readlineDevicePicker.isInteractive()).toBe(false);
  });
});

describe('promptForChoiceIndex', () => {
  it('resolves to the 0-based index of a valid first answer', async () => {
    const { rl, input } = fakeReadlineInterface();
    const resultPromise = promptForChoiceIndex(rl, 3);
    input.write('2\n');
    expect(await resultPromise).toBe(1);
    rl.close();
  });

  it('re-prompts on invalid input (out of range, non-numeric) instead of giving up', async () => {
    const { rl, input } = fakeReadlineInterface();
    const resultPromise = promptForChoiceIndex(rl, 3);
    // Written one at a time, each after the previous has actually been
    // read — `readline` reads its input stream as a raw byte stream that
    // needs a tick to arrive, independent of when its `question` callback
    // fires, so writing every line in the same tick can leave later ones
    // sitting unread in the stream past the point this loop's already
    // moved on to a fresh `question` call for them.
    input.write('bogus\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    input.write('99\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    input.write('2\n');
    expect(await resultPromise).toBe(1);
    rl.close();
  });

  it('resolves to undefined (never hangs) when the input stream closes mid-prompt, before any answer arrives', async () => {
    const { rl, input } = fakeReadlineInterface();
    const resultPromise = promptForChoiceIndex(rl, 3);
    input.end(); // closes with nothing ever written — no line for `question`'s callback to fire on
    // A real hang would make this test itself time out (vitest's own
    // per-test default) rather than fail with an assertion — this
    // `Promise.race` turns that into a clear failure instead.
    const result = await Promise.race([
      resultPromise,
      new Promise<'TIMED_OUT'>((resolve) => setTimeout(() => resolve('TIMED_OUT'), 2_000)),
    ]);
    expect(result).toBeUndefined();
  });
});
