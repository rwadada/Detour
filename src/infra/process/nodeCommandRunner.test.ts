import { describe, expect, it } from 'vitest';
import { CommandRunError } from '../../usecase/ports/commandRunner';
import { nodeCommandRunner } from './nodeCommandRunner';

describe('nodeCommandRunner', () => {
  it('resolves with stdout/stderr on a successful command', async () => {
    const result = await nodeCommandRunner.run('node', ['-e', "process.stdout.write('hi')"]);
    expect(result.stdout).toBe('hi');
  });

  it('rejects with a CommandRunError whose notFound is true for a missing binary (ENOENT)', async () => {
    await expect(nodeCommandRunner.run('detour-definitely-not-a-real-binary', [])).rejects.toMatchObject({
      constructor: CommandRunError,
      notFound: true,
    });
  });

  it('rejects with a CommandRunError whose notFound is false for a real nonzero exit', async () => {
    await expect(nodeCommandRunner.run('node', ['-e', 'process.exit(1)'])).rejects.toMatchObject({
      constructor: CommandRunError,
      notFound: false,
    });
  });
});
