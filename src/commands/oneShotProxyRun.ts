import { DetourEventBus } from '../infra/eventBus';
import { fsRulesFileReader } from '../infra/fs/rulesFileSource';
import { logProxyError } from '../presentation/logger';
import { RuleEngine } from '../usecase/ruleEngine';

/** Loads a `RuleEngine` for `--rules` if given, shared by `runTestCommand` and `runRecordCommand` — neither watches for changes, since both are one-shot runs bounded by the command under test's own exit. */
export function loadOptionalRuleEngine(
  rulesPath: string | undefined,
  allowExternalScriptPaths: boolean,
): RuleEngine | undefined {
  if (!rulesPath) return undefined;
  return RuleEngine.load({
    filePath: rulesPath,
    reader: fsRulesFileReader,
    allowExternalScriptPaths,
    watch: false,
  });
}

/** An event bus with `detour start`'s own proxy-error logging already wired in, shared by `runTestCommand` and `runRecordCommand` — without it, a proxy-level failure (a connect error, a broken tunnel) during the run would be silently dropped instead of explaining why a request never showed up as a captured exchange. */
export function createEventBusWithErrorLogging(): DetourEventBus {
  const eventBus = new DetourEventBus();
  eventBus.on('error', logProxyError);
  return eventBus;
}
