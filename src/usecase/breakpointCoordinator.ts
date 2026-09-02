import type { BreakpointResumeCommand } from '../domain/exchange/types';

/**
 * Tracks exchanges paused by a `breakpoint` rule, keyed by `${id}:${phase}`,
 * and resolves the matching wait once the dashboard resumes/aborts it — or
 * synthetically, on a proxy-level error, so a dropped connection never
 * leaves a pause hanging forever (see infra/proxy/proxyServer.ts's `onError`
 * handler). Pure orchestration state — no `IContext`/socket dependency.
 */
export class BreakpointCoordinator {
  private readonly pending = new Map<string, (command: BreakpointResumeCommand) => void>();

  wait(id: string, phase: 'request'): Promise<Extract<BreakpointResumeCommand, { phase: 'request' }>>;
  wait(id: string, phase: 'response'): Promise<Extract<BreakpointResumeCommand, { phase: 'response' }>>;
  wait(id: string, phase: 'request' | 'response'): Promise<BreakpointResumeCommand> {
    return new Promise((resolve) => {
      this.pending.set(`${id}:${phase}`, resolve);
    });
  }

  /** Resolves the pending wait for `command.id`/`command.phase`, if one exists. No-op otherwise (e.g. the exchange already finished). */
  resolve(command: BreakpointResumeCommand): void {
    const key = `${command.id}:${command.phase}`;
    const resolve = this.pending.get(key);
    if (!resolve) return;
    this.pending.delete(key);
    resolve(command);
  }
}
