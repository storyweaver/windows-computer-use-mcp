/**
 * Copied from Claude Code src/utils/computerUse/swiftLoader.ts
 * Only change: no platform check (caller handles it).
 */

import type { ComputerUseAPI } from "@ant/computer-use-swift";

let cached: ComputerUseAPI | undefined;

export function requireComputerUseSwift(): ComputerUseAPI {
  if (process.platform !== "darwin") {
    throw new Error("@ant/computer-use-swift is macOS-only");
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (cached ??= require("@ant/computer-use-swift") as ComputerUseAPI);
}

export type { ComputerUseAPI };
