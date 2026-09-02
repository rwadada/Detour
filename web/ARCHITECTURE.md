# Dashboard Architecture

The dashboard (`web/`) follows [Feature-Sliced Design](https://feature-sliced.design/) (FSD).
This document explains the layer structure, the app-specific patterns built on top of it, and how
to extend it. For the backend (`src/`)'s Clean Architecture layering, see the root `README.md` /
issue #29 — the two are independent, parallel efforts; this document covers `web/` only.

Layer/slice boundaries are enforced mechanically by [Steiger](https://github.com/feature-sliced/steiger)
(`npm run lint:fsd`, wired into `npm run verify`), not just by convention — a misplaced import fails
the build the same way a type error does.

## Layers

FSD layers are ordered outer → inner; **a module may only import from layers below its own**:

```
app          — composition root: routing/providers/global styles (none needed here yet)
  ↓
widgets      — self-contained UI chunks composed of features/entities (Header, LogTable, …)
  ↓
features     — user-facing capabilities with their own state (Focus, Throttle, Intercept, …)
  ↓
entities     — core business objects (a captured exchange, a proxy error)
  ↓
shared       — generic, business-agnostic code (UI kit, utils, the server connection)
```

`pages` and `processes` are unused: this dashboard is a single view with no routing, so there's
nothing for either to hold. If routing is ever added, `pages` is where each route's top-level
composition would go.

Within a layer, code is grouped into **slices** (one per business concept — `features/focus`,
`entities/exchange`, …), and within a slice, into **segments** by technical purpose: `ui/`
(components), `model/` (state and business logic), `lib/` (slice-local helpers). A slice's only
public surface is its `index.ts` — importing from inside a slice's `ui/`/`model/` from *outside*
that slice (`import { useFocusStore } from '@/features/focus/model/store'` instead of
`from '@/features/focus'`) is exactly what Steiger's `no-public-api-sidestep` rule catches.

## Current slices

| Layer | Slice | Holds |
|---|---|---|
| widgets | `header` | Top bar: branding, connection status, composes the Intercept/Focus/Throttle controls |
| widgets | `filter-bar` | Search/method/status filters, exchange count, clear |
| widgets | `log-table` | Virtualized, live-scrolling list of captured exchanges |
| widgets | `inspector-panel` | Selected exchange's headers/query/body (or the breakpoint editor, if paused) |
| features | `focus` | The "Focus" host allowlist (issue #12) |
| features | `throttle` | Simulated bandwidth/latency/packet-loss (issue #13) |
| features | `intercept-toggle` | Master MITM on/off switch |
| features | `breakpoint-resume` | Pausing/editing/resuming or aborting an exchange mid-flight |
| features | `log-viewer` | Loading a saved HAR/JSON log file and viewing it without a running proxy (issue #19) |
| features | `log-export` | Exporting the captured log as HAR 1.2 or Detour's native JSON (issue #19) |
| entities | `exchange` | The captured-traffic list itself: data, selection, filtering |
| entities | `proxy-error` | Proxy-level errors (connection resets, TLS failures, …) — captured, no UI surfaces them yet (see `steiger.config.ts`) |
| shared | `api` | `DashboardConnection` (the WebSocket to the proxy) and the wire protocol types |
| shared | `ui` | Generic UI kit: `Button`, `Input`, `Select`, `Tabs`, `Badge`, `PillToggle` |
| shared | `lib` | Generic helpers with no server/business knowledge: `RingBuffer`, `cn`, formatters, `theme`, popover dismissal |

## The `DashboardConnection` pattern

The dashboard has exactly one connection to the proxy's WebSocket, but six independent pieces of
state need to react to different messages on it (exchanges, breakpoints, intercept/focus/throttle,
proxy errors). Rather than one store owning the socket and everyone else reaching into it — the
pre-FSD design, and exactly the kind of tight coupling FSD's layering exists to prevent — the
connection is a **shared pub/sub primitive** (`shared/api/createDashboardConnection.ts`) that every
entity/feature store subscribes to independently:

```
shared/api/ws.ts                   — raw WebSocket + reconnect-with-backoff (unchanged wire logic)
shared/api/createDashboardConnection.ts
                                    — fan-out: onMessage()/onStatusChange() have many independent
                                      subscribers; send() forwards to the socket
shared/api/dashboardConnection.ts  — the app's one real instance (see below)

entities/exchange/model/createExchangeStore.ts     — subscribes to backlog/request/response/breakpoint
entities/proxy-error/model/createProxyErrorStore.ts — subscribes to error
features/intercept-toggle/model/createInterceptStore.ts — subscribes to intercept
features/focus/model/createFocusStore.ts                — subscribes to focus
features/throttle/model/createThrottleStore.ts          — subscribes to throttle
features/breakpoint-resume/model/createBreakpointResumeStore.ts — subscribes to breakpoint/request/response
```

Each `createXStore(connection)` factory takes the connection as a **required** parameter — no
default — so a test can hand it a fake (`shared/api`'s `fakeDashboardConnection()`) instead of ever
opening a real socket. This is also why each slice with server-backed state splits into three files:

- **`model/createXStore.ts`** — the pure factory. Importing it has zero side effects; this is what
  `*.test.ts` files import.
- **`model/store.ts`** — `export const useXStore = createXStore(getDashboardConnection())`: the
  real, app-wide singleton.
- **`index.ts`** — the slice's public API, re-exporting `useXStore` (and the UI/types other slices
  need) for everyone *outside* the slice to import.

`getDashboardConnection()` (not a plain `export const dashboardConnection = …`) matters here:
Steiger's public-API rule means test files import `fakeDashboardConnection` through the
`shared/api` *barrel* (`index.ts`), and a barrel eagerly evaluates every one of its own re-exports
— so if the real connection were constructed at module scope, merely importing the barrel for the
fake would open a real WebSocket as a side effect. `getDashboardConnection()` constructs it lazily,
on first call, memoized — importing the barrel does nothing until something actually asks for the
real connection (each slice's own `model/store.ts`, exactly once per store).

`entities/exchange` and `entities/proxy-error` skip the `model/store.ts` split: nothing *inside*
either slice's own `ui/` needs the store (their UI is presentational, taking props), so their
`index.ts` wires the real singleton directly without risking a same-slice circular import.

## Adding a new feature or entity

1. `mkdir -p web/src/features/<name>/{model,ui}` (or `entities/`).
2. `model/create<Name>Store.ts`: a factory taking `connection: DashboardConnection`, subscribing to
   whichever message type(s) it owns via `connection.onMessage`, sending commands via
   `connection.send`. Write `model/create<Name>Store.test.ts` against it directly, using
   `fakeDashboardConnection()` from `@/shared/api`.
3. If anything in `ui/` needs the store, add `model/store.ts` (`createXStore(getDashboardConnection())`)
   and import *that* from `ui/`, not the slice's own `index.ts` (avoids the circular import — see
   above).
4. `index.ts`: re-export exactly what other slices should be able to use — not everything internal.
5. `npm run lint:fsd --workspace web` to confirm the layer/public-API rules hold.

## Known deviations from strict FSD

- **`shared/api/protocol.ts` owns every wire-message type** (`CapturedExchange`, `BreakpointPayload`,
  `ThrottleState`, …), even though most of those are conceptually "owned" by an entity/feature.
  The alternative — entities/features each defining their own copy — would duplicate the wire
  contract; `shared` importing from entities/features to build the message union would invert the
  dependency direction entirely. Since `shared` sits below everything, entities/features importing
  *from* it (`import type { CapturedExchange } from '@/shared/api'`) is the correct direction, and
  matches how the backend treats this same contract (`src/dashboard/protocol.ts` lives at its
  innermost layer too — see issue #29).
- **`features/focus`, `features/intercept-toggle`, `features/throttle`** each have exactly one
  current consumer (`widgets/header`), which Steiger's `fsd/insignificant-slice` rule flags by
  default (suggesting they be merged into Header). They're kept separate — and the rule silenced
  for them in `steiger.config.ts` — because issues #24/#19 plan to relocate each independently
  (toolbar/sidebar/Settings panel); merging now would just have to be undone later.
- **`entities/proxy-error`** has no consumer at all yet — `fsd/insignificant-slice` silenced there
  too. It mirrors `ProxyErrorEvent` messages the server already sends; no UI surfaces them yet
  (same gap the pre-FSD store had). Kept ready for #19/#24's planned error surface.
