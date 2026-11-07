import type { CapturedExchange } from './types';
import type { ExchangeContext } from './exchangeContext';

/**
 * Registry holding all in-flight `ExchangeContext`s keyed by their exchange ID
 * (`ctx.uuid`). Centralizes context creation, retrieval, and final cleanup
 * (issue #208).
 */
export class ExchangeRegistry {
  private readonly contexts = new Map<string, ExchangeContext>();

  create(id: string, exchange: CapturedExchange): ExchangeContext {
    const ctx: ExchangeContext = { id, exchange };
    this.contexts.set(id, ctx);
    return ctx;
  }

  get(id: string): ExchangeContext | undefined {
    return this.contexts.get(id);
  }

  getExchange(id: string): CapturedExchange | undefined {
    return this.contexts.get(id)?.exchange;
  }

  finalize(id: string): ExchangeContext | undefined {
    const ctx = this.contexts.get(id);
    this.contexts.delete(id);
    return ctx;
  }

  has(id: string): boolean {
    return this.contexts.has(id);
  }

  get size(): number {
    return this.contexts.size;
  }

  clear(): void {
    this.contexts.clear();
  }
}
