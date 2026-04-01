/**
 * Copied from Claude Code src/utils/computerUse/common.ts
 * Change: import env from shims instead of ../env.js
 */

import { env } from "./shims.js";

export const COMPUTER_USE_MCP_SERVER_NAME = "computer-use";

export const CLI_HOST_BUNDLE_ID = "com.anthropic.claude-code.cli-no-window";

const TERMINAL_BUNDLE_ID_FALLBACK: Readonly<Record<string, string>> = {
  "iTerm.app": "com.googlecode.iterm2",
  Apple_Terminal: "com.apple.Terminal",
  ghostty: "com.mitchellh.ghostty",
  kitty: "net.kovidgoyal.kitty",
  WarpTerminal: "dev.warp.Warp-Stable",
  vscode: "com.microsoft.VSCode",
};

export function getTerminalBundleId(): string | null {
  const cfBundleId = process.env.__CFBundleIdentifier;
  if (cfBundleId) return cfBundleId;
  return TERMINAL_BUNDLE_ID_FALLBACK[env.terminal ?? ""] ?? null;
}

export const CLI_CU_CAPABILITIES = {
  screenshotFiltering: "native" as const,
  platform: "darwin" as const,
};
