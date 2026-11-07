---
name: wire-format-change
description: Checklist and validation guide when adding, modifying, or removing fields from `CapturedExchange`, wire formats, or serialization schemas across Detour backend and web frontend. Trigger when changing exchange data models, protocol schemas, or serialization in src/domain/exchange/ or src/domain/dashboard/.
---

# Wire Format & CapturedExchange Change Checklist

Adding, removing, or modifying fields on `CapturedExchange` affects serialization, WebSocket messaging, persistence, HAR conversion, and the web UI across 11+ files. Follow this checklist to ensure all synchronization points are updated without breaking backward compatibility.

## 1. Inventory of Files to Update

When changing `CapturedExchange`, verify all corresponding files:

### Backend Domain & Serialization
- [ ] **`src/domain/exchange/types.ts`**: Update `CapturedExchange` interface and `WireExchange` types.
- [ ] **`src/domain/exchange/wireExchange.ts`**: Update `toWireExchange()` and `fromWireExchange()` conversion functions and their unit tests (`wireExchange.test.ts`).
- [ ] **`src/domain/dashboard/protocol.ts`**: Update schema and protocol message definitions sent over WebSocket.
- [ ] **`src/domain/update/backlogSnapshot.ts`**: Update snapshot serialization across binary update restarts (`backlogSnapshot.test.ts`).

### Persistence & Storage
- [ ] **`src/infra/session/sessionFile.ts`**: Update session save/load JSON serialization (`sessionFile.test.ts`).
- [ ] **`src/infra/history/historyStore.ts`**: Update SQLite table schema, migrations, and row mapping functions (`historyStore.test.ts`).
- [ ] **`src/domain/record/fixtureStore.ts`**: Ensure fixture JSON format used by `detour record` and `detour serve` remains compatible.

### Export & Import
- [ ] **`src/infra/har/harExport.ts`**: Map new exchange attributes to HAR 1.2 fields (or custom `_` fields).
- [ ] **`src/infra/har/harImport.ts`**: Map HAR entries back to `CapturedExchange`.

### Frontend Web Dashboard
- [ ] **`web/src/shared/api/protocol.ts`**: Sync protocol type definitions with backend.
- [ ] **`web/src/entities/exchange/model/createExchangeStore.ts`**: Update frontend state store and deserialization.
- [ ] **`web/src/widgets/log-table/` & `web/src/widgets/inspector-panel/`**: Update UI display, filtering, and inspector panels.

## 2. Backward Compatibility Rules

- [ ] **Optional by Default**: New fields MUST be optional (`field?: type`) so older session files, recordings, and SQLite rows without the field load without error.
- [ ] **Graceful Fallback**: Deserializers must provide safe fallback defaults (e.g., `row.insecureUpstream ?? false`).
- [ ] **Database Migration**: If modifying the SQLite schema, add a non-destructive column addition (`ALTER TABLE exchanges ADD COLUMN ...`) with default values.

## 3. Verification Commands

Run the full typecheck (covers protocol parity between backend and frontend):
```bash
npm run typecheck
```

Run targeted serialization & persistence tests:
```bash
npx vitest run src/domain/exchange/wireExchange.test.ts
npx vitest run src/domain/update/backlogSnapshot.test.ts
npx vitest run src/infra/history/historyStore.test.ts
```

Run CLI recording and replay tests:
```bash
npx vitest run --config vitest.e2e.config.ts -t "detour record / detour serve"
```
