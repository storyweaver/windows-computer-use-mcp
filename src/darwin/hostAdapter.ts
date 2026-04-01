/**
 * Copied from Claude Code src/utils/computerUse/hostAdapter.ts
 * Changes:
 *   - import from shims instead of Claude Code internals
 *   - replace GrowthBook gates with standalone defaults
 *   - use our file logger instead of DebugLogger
 */

import type {
  ComputerUseHostAdapter,
  CuSubGates,
} from "../upstream/types.js";
import { ALL_SUB_GATES_ON } from "../upstream/subGates.js";
import { createFileLogger } from "../logger.js";
import { COMPUTER_USE_MCP_SERVER_NAME } from "./common.js";
import { createCliExecutor } from "./executor.js";
import { requireComputerUseSwift } from "./swiftLoader.js";

/**
 * Standalone sub-gates — replaces GrowthBook getChicagoSubGates().
 * Matches the production defaults from gates.ts.
 */
const STANDALONE_SUB_GATES: CuSubGates = {
  ...ALL_SUB_GATES_ON,
  pixelValidation: false,    // cropRawPatch is async-only (sharp), interface is sync
  autoTargetDisplay: false,  // not wired in standalone mode
  clipboardGuard: false,     // no Electron clipboard module
};

let cached: ComputerUseHostAdapter | undefined;

export function getComputerUseHostAdapter(): ComputerUseHostAdapter {
  if (cached) return cached;

  const logger = createFileLogger(COMPUTER_USE_MCP_SERVER_NAME);
  const subGates = { ...STANDALONE_SUB_GATES };

  cached = {
    serverName: COMPUTER_USE_MCP_SERVER_NAME,
    logger,
    executor: createCliExecutor({
      getMouseAnimationEnabled: () => subGates.mouseAnimation,
      getHideBeforeActionEnabled: () => subGates.hideBeforeAction,
    }),
    ensureOsPermissions: async () => {
      const cu = requireComputerUseSwift();
      const accessibility = cu.tcc.checkAccessibility();
      const screenRecording = cu.tcc.checkScreenRecording();
      return accessibility && screenRecording
        ? { granted: true }
        : { granted: false, accessibility, screenRecording };
    },
    isDisabled: () => false,
    getSubGates: () => subGates,
    getAutoUnhideEnabled: () => true,
    cropRawPatch: () => null,
  };
  return cached;
}
