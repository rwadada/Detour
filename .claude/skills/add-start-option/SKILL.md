---
name: add-start-option
description: Step-by-step template and checklist for adding a new CLI flag or configuration option to `detour start`, from option parsing and config persistence to dashboard UI and documentation. Trigger when asked to add a new CLI option/flag to `detour start`, support a new startup configuration, or "オプション追加".
---

# Adding a New CLI Option to `detour start`

Adding a flag to `detour start` requires wiring through option parsing, config file persistence, startup banners, the web dashboard, docs, and E2E tests. Follow this sequential guide to avoid missing integration points.

## 1. Sequence of Changes

### Step 1: Domain Type Definition
Add the option and its type to `StartOptions`:
- **File**: `src/domain/daemon/types.ts`
- **Action**: Add property with JSDoc comment explaining its meaning and default value.

### Step 2: Option Parser & Validation
Implement argument parsing and validation:
- **File**: `src/commands/optionParsers.ts`
- **Action**: Add parser function (e.g. `parseMyOption(val: string): MyOptionType`) and export it.
- **Unit Test**: `src/commands/optionParsers.test.ts` (or co-located parser tests).

### Step 3: Register Commander Option
Register the CLI flag on `detour start`:
- **File**: `src/commands/startCommand.ts`
- **Action**: Add `.option('--my-option <val>', 'description')` and map it into `StartOptions`.

### Step 4: Configuration File Persistence
Allow persisting the setting into `~/.detour/config.json`:
- **File**: `src/commands/configCommand.ts`
- **Action**: Support `detour config --my-option <val>` and `detour config --my-option off`.
- **Unit Test**: `src/infra/cli/commands/configCommand.test.ts`.

### Step 5: Startup Banner (If User-Facing)
If the option modifies startup behavior in a notable way (like `--lan`, `--insecure-upstream`, `--client-cert`):
- **File**: `src/presentation/banner.ts`
- **Action**: Add status line in the startup banner.
- **Unit Test**: `src/presentation/banner.test.ts`.

### Step 6: Exposing to Web Dashboard
If the option affects client-side inspection or should appear in `proxyInfo` / Settings panel:
- **Backend Protocol**: `src/domain/dashboard/protocol.ts` (add to `ProxyInfo` message).
- **Backend Service**: `src/infra/dashboard/dashboardServer.ts` (populate in `proxyInfo`).
- **Frontend Store**: `web/src/entities/proxy-config/model/createProxyInfoStore.ts`.
- **Frontend UI**: `web/src/features/settings-panel/ui/SettingsPanel.tsx`.

### Step 7: Documentation
- Update `README.md` CLI options table.
- Update `docs/` documentation site if applicable.

### Step 8: End-to-End Tests
Add CLI test coverage verifying:
1. Command line argument takes precedence: `detour start --my-option ...`
2. Config file fallback works: `detour config --my-option ...` then bare `detour start`
- **File**: `src/cli.e2e.test.ts`

## 2. Verification Checklist

Before submitting a PR, verify:
```bash
# 1. Typecheck & Lint
npm run typecheck
npm run lint

# 2. Unit & Integration Tests
npm run test:coverage

# 3. Targeted E2E Test
npx vitest run --config vitest.e2e.config.ts -t "my-option"
```
