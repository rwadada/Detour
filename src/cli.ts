import { Command } from 'commander';
import { registerCertCommand } from './commands/certCommand';
import { registerConfigCommand } from './commands/configCommand';
import { registerProcessCommands } from './commands/processCommands';
import { registerRecordCommand } from './commands/recordCommand';
import { registerRulesCommands } from './commands/rulesCommand';
import { registerServeCommand } from './commands/serveCommand';
import { registerSetupCommands } from './commands/setupCommand';
import { registerStartCommand } from './commands/startCommand';
import { registerTestCommand } from './commands/testCommand';

// Detour's composition root. Every subcommand's wiring lives in its own
// module under `src/commands/` (issue #168 — this file was 1,837 lines of
// them before); what's left here is the program itself and the list of what
// it can do.
//
// `src/commands/**` and this file are the one place allowed to import across
// every layer (domain/usecase/infra/presentation) to wire concrete
// Infrastructure adapters (the real filesystem, ProxyEngine, ws) into the
// UseCases that only depend on their ports. Everything else is checked by
// `boundaries/element-types` (see eslint.config.mjs), which registers these
// as the `main` element type so that wiring has somewhere legitimate to live.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- reads package.json at runtime; a static `import` would need resolveJsonModule wired through the CJS build.
const pkg = require('../package.json') as { version: string; description: string };

export function createCli(): Command {
  const program = new Command();

  program.name('detour').description(pkg.description).version(pkg.version);

  registerStartCommand(program);
  registerProcessCommands(program);
  registerConfigCommand(program);
  registerCertCommand(program);
  registerSetupCommands(program);
  registerTestCommand(program);
  registerRecordCommand(program);
  registerServeCommand(program);
  registerRulesCommands(program);

  return program;
}

// Runs the CLI when this file is executed directly (`tsx src/cli.ts ...`,
// `npm run dev`) — but stays a pure module (no side effect) when merely
// imported, e.g. by `bin/detour.js` (which requires the *built* `dist/cli.js`
// and calls `.parse()` itself) or by tests importing `createCli` without
// wanting it to run.
if (require.main === module) {
  createCli().parse(process.argv);
}
