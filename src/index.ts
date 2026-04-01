/**
 * Cross-platform Computer Use MCP Server — stdio entry point.
 *
 * macOS: uses original Claude Code executor (SCContentFilter, enigo, TCC)
 * Windows: uses argus native layer (node-screenshots, robotjs, Win32 API)
 *
 * Platform detection at startup, dynamic imports for isolation.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createComputerUseMcpServer,
} from "./upstream/mcpServer.js";
import type {
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
  AppGrant,
  CuGrantFlags,
  CoordinateMode,
  CuPermissionResponse,
  CuPermissionRequest,
  ScreenshotDims,
} from "./upstream/types.js";
import { DEFAULT_GRANT_FLAGS } from "./upstream/types.js";
import { getLogDir } from "./logger.js";

// ── Platform detection ────────────────────────────────────────────────────

async function createHostAdapter(): Promise<ComputerUseHostAdapter> {
  if (process.platform === "darwin") {
    const { getComputerUseHostAdapter } = await import("./darwin/hostAdapter.js");
    return getComputerUseHostAdapter();
  }

  if (process.platform === "win32") {
    const { createWindowsHostAdapter } = await import("./host-adapter.js");
    return createWindowsHostAdapter({ serverName: "argus" });
  }

  throw new Error(
    `Unsupported platform: ${process.platform}. ` +
    `Argus supports macOS (darwin) and Windows (win32).`,
  );
}

// ── Lock integration ──────────────────────────────────────────────────────

async function createLockCallbacks(): Promise<{
  checkCuLock?: () => Promise<{ holder: string | undefined; isSelf: boolean }>;
  acquireCuLock?: () => Promise<void>;
  formatLockHeldMessage?: (holder: string) => string;
  release: () => Promise<void>;
}> {
  if (process.platform === "darwin") {
    const {
      checkComputerUseLock,
      tryAcquireComputerUseLock,
      releaseComputerUseLock,
    } = await import("./darwin/computerUseLock.js");

    return {
      checkCuLock: async () => {
        const result = await checkComputerUseLock();
        if (result.kind === "free") return { holder: undefined, isSelf: false };
        if (result.kind === "held_by_self") return { holder: result.kind, isSelf: true };
        return { holder: result.by, isSelf: false };
      },
      acquireCuLock: async () => {
        const result = await tryAcquireComputerUseLock();
        if (result.kind === "blocked") {
          throw new Error(`CU lock held by ${result.by}`);
        }
      },
      formatLockHeldMessage: (holder: string) =>
        `Another session (${holder}) is currently using the computer. ` +
        `Wait for it to finish, or stop it before starting a new one.`,
      release: async () => { await releaseComputerUseLock(); },
    };
  }

  // Windows: no lock for now (single-user typical)
  return { release: async () => {} };
}

// ── Session context (auto-approve) ────────────────────────────────────────

function createAutoApproveSessionContext(lock: {
  checkCuLock?: () => Promise<{ holder: string | undefined; isSelf: boolean }>;
  acquireCuLock?: () => Promise<void>;
  formatLockHeldMessage?: (holder: string) => string;
}): ComputerUseSessionContext {
  let allowedApps: AppGrant[] = [];
  let grantFlags: CuGrantFlags = { ...DEFAULT_GRANT_FLAGS };
  let selectedDisplayId: number | undefined;
  let lastScreenshotDims: ScreenshotDims | undefined;

  return {
    getAllowedApps: () => allowedApps,
    getGrantFlags: () => grantFlags,
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () => selectedDisplayId,
    getLastScreenshotDims: () => lastScreenshotDims,

    onPermissionRequest: async (
      req: CuPermissionRequest,
      _signal: AbortSignal,
    ): Promise<CuPermissionResponse> => {
      const granted: AppGrant[] = req.apps
        .filter((a) => a.resolved && !a.alreadyGranted)
        .map((a) => ({
          bundleId: a.resolved!.bundleId,
          displayName: a.resolved!.displayName,
          grantedAt: Date.now(),
          tier: a.proposedTier,
        }));

      return {
        granted,
        denied: req.apps
          .filter((a) => !a.resolved)
          .map((a) => ({
            bundleId: a.requestedName,
            reason: "not_installed" as const,
          })),
        flags: {
          clipboardRead: req.requestedFlags.clipboardRead ?? false,
          clipboardWrite: req.requestedFlags.clipboardWrite ?? false,
          systemKeyCombos: req.requestedFlags.systemKeyCombos ?? false,
        },
      };
    },

    onAllowedAppsChanged: (apps, flags) => {
      allowedApps = [...apps];
      grantFlags = flags;
    },

    onResolvedDisplayUpdated: (displayId) => {
      selectedDisplayId = displayId;
    },

    onScreenshotCaptured: (dims) => {
      lastScreenshotDims = dims;
    },

    // CU Lock
    checkCuLock: lock.checkCuLock,
    acquireCuLock: lock.acquireCuLock,
    formatLockHeldMessage: lock.formatLockHeldMessage,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const adapter = await createHostAdapter();
  const lock = await createLockCallbacks();

  const coordinateMode: CoordinateMode = "pixels";
  const sessionCtx = createAutoApproveSessionContext(lock);

  const server = createComputerUseMcpServer(
    adapter,
    coordinateMode,
    sessionCtx,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const platformLabel =
    process.platform === "darwin" ? "macOS" :
    process.platform === "win32" ? "Windows" :
    process.platform;

  adapter.logger.info(
    `Argus Computer Use MCP Server started (${platformLabel}, stdio). Logs → ${getLogDir()}`,
  );

  process.on("SIGINT", async () => {
    await lock.release();
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
