# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
npm run build          # TypeScript compilation (tsc) → dist/
npm test               # Run all 70 tests (unit + integration)
npm run test:unit      # Unit tests only
npm run test:integration  # Integration tests only (interact with real desktop)
npx vitest run tests/unit/upstream/keyBlocklist.test.ts  # Single test file
npx tsc --noEmit       # Type-check without emitting
npm start              # Run the MCP server (stdio transport)
```

Tests run **sequentially** (fileParallelism: false) because clipboard and input tests share OS state. ESM module system — all imports use `.js` extensions.

## Architecture

Two-layer design: **upstream** (Anthropic's Chicago MCP, platform-agnostic) sits on top of **native** (Windows implementations).

```
index.ts → createWindowsHostAdapter() → createComputerUseMcpServer() → StdioServerTransport

                 ┌─── upstream/ (6,300 lines, DO NOT MODIFY) ───┐
                 │  toolCalls.ts — 3,649-line dispatch engine     │
                 │  mcpServer.ts — bindSessionContext + Server    │
                 │  tools.ts — 24 tool schema definitions         │
                 │  types.ts — all interfaces                     │
                 │  executor.ts — ComputerExecutor interface       │
                 └────────────────┬───────────────────────────────┘
                                  │ ComputerExecutor interface
                 ┌────────────────▼───────────────────────────────┐
                 │  executor-windows.ts — assembles native modules │
                 │  native/screen.ts — node-screenshots + sharp    │
                 │  native/input.ts — robotjs                      │
                 │  native/window.ts — koffi + Win32 API           │
                 │  native/clipboard.ts — PowerShell               │
                 └────────────────────────────────────────────────┘
```

### Key rule: upstream/ is read-only

The `src/upstream/` directory contains Anthropic's Chicago MCP code copied from `@ant/computer-use-mcp`. Only 1 line was changed (a path undefined check in toolCalls.ts:1162). Never modify these files — adapt via wrappers in the outer layer. This preserves the ability to sync with future upstream updates.

### ComputerExecutor — the abstraction boundary

`src/upstream/executor.ts` defines the `ComputerExecutor` interface. This is the **only** contract between upstream and native. The upstream layer calls executor methods; `executor-windows.ts` implements them by delegating to native modules. To add a new platform, implement this interface.

### Sub-gates (CuSubGates)

Feature flags in `host-adapter.ts` control runtime behavior. Several are OFF on Windows for platform reasons:
- `pixelValidation: false` — `cropRawPatch` interface is sync, sharp is async
- `hideBeforeAction: false` — minimizing windows breaks WebView2 child processes
- `autoTargetDisplay: false` — no atomic Swift resolver
- `clipboardGuard: false` — no Electron clipboard module

### Session context (auto-approve mode)

`index.ts` creates an auto-approve session context where `onPermissionRequest` grants all requested apps automatically. In Claude Code's desktop app, this would route through a UI dialog. The standalone MCP server skips that since the user opted in by running it.

## Known platform issues

- **CJK text input**: robotjs `typeString` triggers Windows IME, producing garbled text. Non-ASCII text must go through clipboard paste (`write_clipboard` + `key("ctrl+v")`).
- **robotjs modifier quirk**: `keyTap(key, undefined)` throws — must pass `[]` instead of `undefined` for the modifiers parameter.
- **listInstalledApps**: Only returns currently visible/running apps. Apps not running can't be found by `request_access`. Workaround: launch the app first via bash, then call `request_access`.
- **FINDER_BUNDLE_ID**: upstream toolCalls.ts hardcodes `com.apple.finder` as always-allowed frontmost. Windows equivalent `EXPLORER.EXE` won't match. Users should add Explorer to their allowlist.

## Logs

Runtime logs at `%LOCALAPPDATA%\argus-automation\logs\mcp-YYYY-MM-DD.log`. Logger is in `src/logger.ts`.
