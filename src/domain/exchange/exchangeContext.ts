import type { CapturedExchange } from './types';
import type { Rule } from '../rules/types';
import type { ScriptModule } from '../rules/scriptAction';

/**
 * Aggregates all per-exchange state for a single in-flight HTTP(S) exchange
 * (Flow equivalent in mitmproxy) — issue #208. Replaces the 5 parallel Maps
 * (inFlight, ruleContexts, rewriteContexts, scriptModules, scriptRequestBodies)
 * that previously tracked an exchange across its pipeline phases.
 */
export interface ExchangeContext {
  readonly id: string;
  exchange: CapturedExchange;
  terminalRule?: Rule;
  rewriteRules?: Rule[];
  scriptModule?: ScriptModule;
  scriptRequestBody?: Buffer;
}
