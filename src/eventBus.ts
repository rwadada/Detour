import { EventEmitter } from 'node:events';
import type { DetourEvents } from './types';

/**
 * Thin, strongly-typed wrapper around Node's EventEmitter.
 *
 * This is the in-memory backbone that decouples traffic capture (the proxy
 * server) from consumers (console logger today, the web dashboard's
 * WebSocket broadcaster in a later issue).
 */
export class DetourEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: true });

  constructor() {
    // Capturing can run for a long time with many listeners (dashboard,
    // recorders, etc). Raise the default cap so Node doesn't warn.
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof DetourEvents>(event: K, listener: DetourEvents[K]): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof DetourEvents>(event: K, listener: DetourEvents[K]): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof DetourEvents>(event: K, ...args: Parameters<DetourEvents[K]>): void {
    this.emitter.emit(event, ...args);
  }
}
