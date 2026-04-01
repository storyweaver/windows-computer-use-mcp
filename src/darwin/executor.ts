/**
 * Copied from Claude Code src/utils/computerUse/executor.ts
 * Changes: import paths point to local shims and upstream package
 */

import type {
  ComputerExecutor,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from "../upstream/executor.js";

import { API_RESIZE_PARAMS, targetImageSize } from "../upstream/imageResize.js";
import {
  logForDebugging,
  errorMessage,
  execFileNoThrow,
  sleep,
} from "./shims.js";
import {
  CLI_CU_CAPABILITIES,
  CLI_HOST_BUNDLE_ID,
  getTerminalBundleId,
} from "./common.js";
import { drainRunLoop } from "./drainRunLoop.js";
import { notifyExpectedEscape } from "./escHotkey.js";
import { requireComputerUseInput } from "./inputLoader.js";
import { requireComputerUseSwift } from "./swiftLoader.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SCREENSHOT_JPEG_QUALITY = 0.75;

function computeTargetDims(
  logicalW: number,
  logicalH: number,
  scaleFactor: number,
): [number, number] {
  const physW = Math.round(logicalW * scaleFactor);
  const physH = Math.round(logicalH * scaleFactor);
  return targetImageSize(physW, physH, API_RESIZE_PARAMS);
}

async function readClipboardViaPbpaste(): Promise<string> {
  const { stdout, code } = await execFileNoThrow("pbpaste", [], {
    useCwd: false,
  });
  if (code !== 0) {
    throw new Error(`pbpaste exited with code ${code}`);
  }
  return stdout;
}

async function writeClipboardViaPbcopy(text: string): Promise<void> {
  const { code } = await execFileNoThrow("pbcopy", [], {
    input: text,
    useCwd: false,
  });
  if (code !== 0) {
    throw new Error(`pbcopy exited with code ${code}`);
  }
}

type Input = ReturnType<typeof requireComputerUseInput>;

function isBareEscape(parts: readonly string[]): boolean {
  if (parts.length !== 1) return false;
  const lower = parts[0]!.toLowerCase();
  return lower === "escape" || lower === "esc";
}

const MOVE_SETTLE_MS = 50;

async function moveAndSettle(
  input: Input,
  x: number,
  y: number,
): Promise<void> {
  await input.moveMouse(x, y, false);
  await sleep(MOVE_SETTLE_MS);
}

async function releasePressed(input: Input, pressed: string[]): Promise<void> {
  let k: string | undefined;
  while ((k = pressed.pop()) !== undefined) {
    try {
      await input.key(k, "release");
    } catch {
      // Swallow — best-effort release.
    }
  }
}

async function withModifiers<T>(
  input: Input,
  mods: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const pressed: string[] = [];
  try {
    for (const m of mods) {
      await input.key(m, "press");
      pressed.push(m);
    }
    return await fn();
  } finally {
    await releasePressed(input, pressed);
  }
}

async function typeViaClipboard(input: Input, text: string): Promise<void> {
  let saved: string | undefined;
  try {
    saved = await readClipboardViaPbpaste();
  } catch {
    logForDebugging(
      "[computer-use] pbpaste before paste failed; proceeding without restore",
    );
  }

  try {
    await writeClipboardViaPbcopy(text);
    if ((await readClipboardViaPbpaste()) !== text) {
      throw new Error("Clipboard write did not round-trip.");
    }
    await input.keys(["command", "v"]);
    await sleep(100);
  } finally {
    if (typeof saved === "string") {
      try {
        await writeClipboardViaPbcopy(saved);
      } catch {
        logForDebugging("[computer-use] clipboard restore after paste failed");
      }
    }
  }
}

async function animatedMove(
  input: Input,
  targetX: number,
  targetY: number,
  mouseAnimationEnabled: boolean,
): Promise<void> {
  if (!mouseAnimationEnabled) {
    await moveAndSettle(input, targetX, targetY);
    return;
  }
  const start = await input.mouseLocation();
  const deltaX = targetX - start.x;
  const deltaY = targetY - start.y;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance < 1) return;
  const durationSec = Math.min(distance / 2000, 0.5);
  if (durationSec < 0.03) {
    await moveAndSettle(input, targetX, targetY);
    return;
  }
  const frameRate = 60;
  const frameIntervalMs = 1000 / frameRate;
  const totalFrames = Math.floor(durationSec * frameRate);
  for (let frame = 1; frame <= totalFrames; frame++) {
    const t = frame / totalFrames;
    const eased = 1 - Math.pow(1 - t, 3);
    await input.moveMouse(
      Math.round(start.x + deltaX * eased),
      Math.round(start.y + deltaY * eased),
      false,
    );
    if (frame < totalFrames) {
      await sleep(frameIntervalMs);
    }
  }
  await sleep(MOVE_SETTLE_MS);
}

// ── Factory ───────────────────────────────────────────────────────────────

export function createCliExecutor(opts: {
  getMouseAnimationEnabled: () => boolean;
  getHideBeforeActionEnabled: () => boolean;
}): ComputerExecutor {
  if (process.platform !== "darwin") {
    throw new Error(
      `createCliExecutor called on ${process.platform}. Computer control is macOS-only.`,
    );
  }

  const cu = requireComputerUseSwift();

  const { getMouseAnimationEnabled, getHideBeforeActionEnabled } = opts;
  const terminalBundleId = getTerminalBundleId();
  const surrogateHost = terminalBundleId ?? CLI_HOST_BUNDLE_ID;
  const withoutTerminal = (allowed: readonly string[]): string[] =>
    terminalBundleId === null
      ? [...allowed]
      : allowed.filter((id) => id !== terminalBundleId);

  logForDebugging(
    terminalBundleId
      ? `[computer-use] terminal ${terminalBundleId} → surrogate host`
      : "[computer-use] terminal not detected; falling back to sentinel host",
  );

  return {
    capabilities: {
      ...CLI_CU_CAPABILITIES,
      hostBundleId: CLI_HOST_BUNDLE_ID,
    },

    async prepareForAction(
      allowlistBundleIds: string[],
      displayId?: number,
    ): Promise<string[]> {
      if (!getHideBeforeActionEnabled()) return [];
      return drainRunLoop(async () => {
        try {
          const result = await cu.apps.prepareDisplay(
            allowlistBundleIds,
            surrogateHost,
            displayId,
          );
          if (result.activated) {
            logForDebugging(
              `[computer-use] prepareForAction: activated ${result.activated}`,
            );
          }
          return result.hidden;
        } catch (err) {
          logForDebugging(
            `[computer-use] prepareForAction failed; continuing: ${errorMessage(err)}`,
            { level: "warn" },
          );
          return [];
        }
      });
    },

    async previewHideSet(
      allowlistBundleIds: string[],
      displayId?: number,
    ): Promise<Array<{ bundleId: string; displayName: string }>> {
      return cu.apps.previewHideSet(
        [...allowlistBundleIds, surrogateHost],
        displayId,
      );
    },

    async getDisplaySize(displayId?: number): Promise<DisplayGeometry> {
      return cu.display.getSize(displayId);
    },

    async listDisplays(): Promise<DisplayGeometry[]> {
      return cu.display.listAll();
    },

    async findWindowDisplays(
      bundleIds: string[],
    ): Promise<Array<{ bundleId: string; displayIds: number[] }>> {
      return cu.apps.findWindowDisplays(bundleIds);
    },

    async resolvePrepareCapture(opts2: {
      allowedBundleIds: string[];
      preferredDisplayId?: number;
      autoResolve: boolean;
      doHide?: boolean;
    }): Promise<ResolvePrepareCaptureResult> {
      const d = cu.display.getSize(opts2.preferredDisplayId);
      const [targetW, targetH] = computeTargetDims(d.width, d.height, d.scaleFactor);
      return drainRunLoop(() =>
        cu.resolvePrepareCapture(
          withoutTerminal(opts2.allowedBundleIds),
          surrogateHost,
          SCREENSHOT_JPEG_QUALITY,
          targetW,
          targetH,
          opts2.preferredDisplayId,
          opts2.autoResolve,
          opts2.doHide,
        ),
      );
    },

    async screenshot(opts2: {
      allowedBundleIds: string[];
      displayId?: number;
    }): Promise<ScreenshotResult> {
      const d = cu.display.getSize(opts2.displayId);
      const [targetW, targetH] = computeTargetDims(d.width, d.height, d.scaleFactor);
      return drainRunLoop(() =>
        cu.screenshot.captureExcluding(
          withoutTerminal(opts2.allowedBundleIds),
          SCREENSHOT_JPEG_QUALITY,
          targetW,
          targetH,
          opts2.displayId,
        ),
      );
    },

    async zoom(
      regionLogical: { x: number; y: number; w: number; h: number },
      allowedBundleIds: string[],
      displayId?: number,
    ): Promise<{ base64: string; width: number; height: number }> {
      const d = cu.display.getSize(displayId);
      const [outW, outH] = computeTargetDims(regionLogical.w, regionLogical.h, d.scaleFactor);
      return drainRunLoop(() =>
        cu.screenshot.captureRegion(
          withoutTerminal(allowedBundleIds),
          regionLogical.x,
          regionLogical.y,
          regionLogical.w,
          regionLogical.h,
          outW,
          outH,
          SCREENSHOT_JPEG_QUALITY,
          displayId,
        ),
      );
    },

    async key(keySequence: string, repeat?: number): Promise<void> {
      const input = requireComputerUseInput();
      const parts = keySequence.split("+").filter((p) => p.length > 0);
      const isEsc = isBareEscape(parts);
      const n = repeat ?? 1;
      await drainRunLoop(async () => {
        for (let i = 0; i < n; i++) {
          if (i > 0) await sleep(8);
          if (isEsc) notifyExpectedEscape();
          await input.keys(parts);
        }
      });
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      const input = requireComputerUseInput();
      const pressed: string[] = [];
      let orphaned = false;
      try {
        await drainRunLoop(async () => {
          for (const k of keyNames) {
            if (orphaned) return;
            if (isBareEscape([k])) notifyExpectedEscape();
            await input.key(k, "press");
            pressed.push(k);
          }
        });
        await sleep(durationMs);
      } finally {
        orphaned = true;
        await drainRunLoop(() => releasePressed(input, pressed));
      }
    },

    async type(text: string, opts2: { viaClipboard: boolean }): Promise<void> {
      const input = requireComputerUseInput();
      if (opts2.viaClipboard) {
        await drainRunLoop(() => typeViaClipboard(input, text));
        return;
      }
      await input.typeText(text);
    },

    readClipboard: readClipboardViaPbpaste,
    writeClipboard: writeClipboardViaPbcopy,

    async moveMouse(x: number, y: number): Promise<void> {
      await moveAndSettle(requireComputerUseInput(), x, y);
    },

    async click(
      x: number,
      y: number,
      button: "left" | "right" | "middle",
      count: 1 | 2 | 3,
      modifiers?: string[],
    ): Promise<void> {
      const input = requireComputerUseInput();
      await moveAndSettle(input, x, y);
      if (modifiers && modifiers.length > 0) {
        await drainRunLoop(() =>
          withModifiers(input, modifiers, () =>
            input.mouseButton(button, "click", count),
          ),
        );
      } else {
        await input.mouseButton(button, "click", count);
      }
    },

    async mouseDown(): Promise<void> {
      await requireComputerUseInput().mouseButton("left", "press");
    },

    async mouseUp(): Promise<void> {
      await requireComputerUseInput().mouseButton("left", "release");
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      return requireComputerUseInput().mouseLocation();
    },

    async drag(
      from: { x: number; y: number } | undefined,
      to: { x: number; y: number },
    ): Promise<void> {
      const input = requireComputerUseInput();
      if (from !== undefined) {
        await moveAndSettle(input, from.x, from.y);
      }
      await input.mouseButton("left", "press");
      await sleep(MOVE_SETTLE_MS);
      try {
        await animatedMove(input, to.x, to.y, getMouseAnimationEnabled());
      } finally {
        await input.mouseButton("left", "release");
      }
    },

    async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
      const input = requireComputerUseInput();
      await moveAndSettle(input, x, y);
      if (dy !== 0) await input.mouseScroll(dy, "vertical");
      if (dx !== 0) await input.mouseScroll(dx, "horizontal");
    },

    async getFrontmostApp(): Promise<FrontmostApp | null> {
      const info = requireComputerUseInput().getFrontmostAppInfo();
      if (!info || !info.bundleId) return null;
      return { bundleId: info.bundleId, displayName: info.appName };
    },

    async appUnderPoint(
      x: number,
      y: number,
    ): Promise<{ bundleId: string; displayName: string } | null> {
      return cu.apps.appUnderPoint(x, y);
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      return drainRunLoop(() => cu.apps.listInstalled());
    },

    async getAppIcon(path: string): Promise<string | undefined> {
      return cu.apps.iconDataUrl(path) ?? undefined;
    },

    async listRunningApps(): Promise<RunningApp[]> {
      return cu.apps.listRunning();
    },

    async openApp(bundleId: string): Promise<void> {
      await cu.apps.open(bundleId);
    },
  };
}

export async function unhideComputerUseApps(
  bundleIds: readonly string[],
): Promise<void> {
  if (bundleIds.length === 0) return;
  const cu = requireComputerUseSwift();
  await cu.apps.unhide([...bundleIds]);
}
