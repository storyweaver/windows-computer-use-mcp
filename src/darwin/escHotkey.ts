/**
 * Copied from Claude Code src/utils/computerUse/escHotkey.ts
 * Change: import from shims
 */

import { logForDebugging } from "./shims.js";
import { releasePump, retainPump } from "./drainRunLoop.js";
import { requireComputerUseSwift } from "./swiftLoader.js";

let registered = false;

export function registerEscHotkey(onEscape: () => void): boolean {
  if (registered) return true;
  const cu = requireComputerUseSwift();
  if (!cu.hotkey.registerEscape(onEscape)) {
    logForDebugging("[cu-esc] registerEscape returned false", { level: "warn" });
    return false;
  }
  retainPump();
  registered = true;
  logForDebugging("[cu-esc] registered");
  return true;
}

export function unregisterEscHotkey(): void {
  if (!registered) return;
  try {
    requireComputerUseSwift().hotkey.unregister();
  } finally {
    releasePump();
    registered = false;
    logForDebugging("[cu-esc] unregistered");
  }
}

export function notifyExpectedEscape(): void {
  if (!registered) return;
  requireComputerUseSwift().hotkey.notifyExpectedEscape();
}
