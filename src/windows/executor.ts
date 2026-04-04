/**
 * Windows ComputerExecutor implementation.
 *
 * Assembles native modules (screen, window, input, clipboard) into the
 * ComputerExecutor interface consumed by upstream toolCalls.ts.
 *
 * Mirrors the CLI executor.ts structure but replaces macOS native calls
 * with Windows equivalents.
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
import {
  captureMonitor,
  captureRegion,
  listMonitors,
  getMonitorGeometry,
} from "./screen.js";
import {
  getForegroundWindowInfo,
  getWindowFromPoint,
  listRunningApps as nativeListRunningApps,
  listVisibleWindows,
  hideWindows,
  unhideWindows,
  activateWindow,
  shellOpen,
  findWindowDisplays as nativeFindWindowDisplays,
  isSystemProcess,
  isExplorer,
  bundleIdToExeName,
} from "./window.js";
import {
  moveMouse as nativeMoveMouse,
  getMousePos,
  mouseClick as nativeMouseClick,
  mouseToggle,
  scrollMouse as nativeScrollMouse,
  keyTap,
  keyToggle,
  typeString,
  typeStringPaced,
} from "./input.js";
import {
  readClipboard as nativeReadClipboard,
  writeClipboard as nativeWriteClipboard,
} from "./clipboard.js";
import type { Logger } from "../upstream/types.js";
import { execFile } from "node:child_process";

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Host bundle ID sentinel. On Windows we're a terminal process — this ID
 * is never the frontmost app (unlike macOS where the terminal window IS
 * visible). The upstream frontmost gate exempts this ID.
 */
const WIN_HOST_BUNDLE_ID = "argus-automation";

/**
 * Windows Explorer — equivalent of macOS Finder. Always allowed as
 * frontmost (desktop, file manager, taskbar).
 */
export const EXPLORER_EXE = "EXPLORER.EXE";

// ── Helpers ─────────────────────────────────────────────────────────────────

const MOVE_SETTLE_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Move the mouse and wait for the position to settle.
 */
async function moveAndSettle(x: number, y: number): Promise<void> {
  nativeMoveMouse(x, y);
  await sleep(MOVE_SETTLE_MS);
}

/**
 * Ease-out-cubic animated mouse movement for drag operations.
 * Port of Cowork's animateMouseMovement.
 */
async function animatedMove(
  targetX: number,
  targetY: number,
  enabled: boolean,
): Promise<void> {
  if (!enabled) {
    await moveAndSettle(targetX, targetY);
    return;
  }

  const start = getMousePos();
  const deltaX = targetX - start.x;
  const deltaY = targetY - start.y;
  const distance = Math.hypot(deltaX, deltaY);

  if (distance < 1) return;

  const durationSec = Math.min(distance / 2000, 0.5);
  if (durationSec < 0.03) {
    await moveAndSettle(targetX, targetY);
    return;
  }

  const frameRate = 60;
  const frameIntervalMs = 1000 / frameRate;
  const totalFrames = Math.floor(durationSec * frameRate);

  for (let frame = 1; frame <= totalFrames; frame++) {
    const t = frame / totalFrames;
    const eased = 1 - Math.pow(1 - t, 3); // ease-out-cubic
    nativeMoveMouse(
      Math.round(start.x + deltaX * eased),
      Math.round(start.y + deltaY * eased),
    );
    if (frame < totalFrames) {
      await sleep(frameIntervalMs);
    }
  }
  await sleep(MOVE_SETTLE_MS);
}

/**
 * Type text via clipboard paste. Saves/restores the user's clipboard.
 * Same pattern as the macOS CLI executor's typeViaClipboard.
 */
async function typeViaClipboard(text: string): Promise<void> {
  let saved: string | undefined;
  try {
    saved = await nativeReadClipboard();
  } catch {
    // proceed without restore capability
  }

  try {
    await nativeWriteClipboard(text);
    // Verify round-trip
    const readBack = await nativeReadClipboard();
    if (readBack !== text) {
      throw new Error("Clipboard write did not round-trip.");
    }
    // Ctrl+V to paste
    keyTap("ctrl+v");
    await sleep(100);
  } finally {
    if (typeof saved === "string") {
      try {
        await nativeWriteClipboard(saved);
      } catch {
        // best-effort restore
      }
    }
  }
}

// ── Helpers: display name extraction ───────────────────────────────────────

/**
 * Extract a clean app display name from a window title.
 * Windows titles often include the document name: "filename - AppName".
 * We extract the part after the last " - " as the app name.
 * Falls back to exe name without extension if no separator found.
 */
function extractAppName(windowTitle: string, exeName: string): string {
  if (!windowTitle) return exeName.replace(/\.exe$/i, "");

  // Common patterns: "Document - AppName", "file.xlsx - Excel"
  const dashIdx = windowTitle.lastIndexOf(" - ");
  if (dashIdx !== -1) {
    const appPart = windowTitle.substring(dashIdx + 3).trim();
    if (appPart.length > 0 && appPart.length < 40) {
      return appPart;
    }
  }

  // If no " - " separator, use the full title if short, else exe name
  return windowTitle.length < 40
    ? windowTitle
    : exeName.replace(/\.exe$/i, "");
}

// ── AUMID-based installed-app scan ─────────────────────────────────────────
// Mirrors the official Claude Desktop approach: AUMID (Application User Model
// ID) as the canonical bundleId for Windows apps. Traditional Win32 apps use
// their lowercase full exe path; UWP/MSIX apps use their AUMID.

interface AumidCache {
  /** Map displayName (lowercase) → bundleId for fuzzy lookup. */
  byName: Map<string, string>;
  /** Map bundleId → AUMID (for UWP launch via shell:AppsFolder). */
  aumidByBundleId: Map<string, string>;
  /** Full installed app list. */
  installed: InstalledApp[];
  lastUpdated: number;
}

const WINDIR = `${process.env.WINDIR ?? "C:\\Windows"}\\`.toLowerCase();
const EXPLORER_FULL_PATH = `${WINDIR}explorer.exe`;
const EXPLORER_AUMID = "Microsoft.Windows.Explorer";

/** Cache TTL: 5 minutes. */
const AUMID_CACHE_TTL = 5 * 60_000;
let _aumidCache: AumidCache | null = null;
let _aumidLastFail = 0;
const AUMID_FAIL_COOLDOWN = 60_000;

/**
 * Normalize an AUMID / exe path to a canonical bundleId.
 * Official logic: if the aumid is the Explorer AUMID → use explorer full path.
 * If targetPath contains backslash → use lowercase exe path.
 * Otherwise use the aumid as-is.
 */
function normalizeBundleId(aumid: string, targetPath: string): string {
  if (aumid === EXPLORER_AUMID) return EXPLORER_FULL_PATH;
  if (targetPath.includes("\\")) return targetPath.toLowerCase();
  if (aumid.includes("\\")) return aumid.toLowerCase();
  return aumid;
}

/**
 * Scan installed apps via two sources:
 * 1. Registry Uninstall keys (traditional Win32 apps)
 * 2. PowerShell Get-AppxPackage (UWP/MSIX apps with AUMIDs)
 *
 * Returns normalized AUMID cache data.
 */
async function scanInstalledApps(): Promise<AumidCache> {
  // Combined PowerShell script: registry scan + AppX enumeration
  const script =
    "$ErrorActionPreference='SilentlyContinue'\n" +
    // Part 1: Registry scan (Win32 apps)
    "$r=@(\n" +
    "  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',\n" +
    "  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',\n" +
    "  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'\n" +
    ")\n" +
    "$reg=$r|%{Get-ItemProperty $_}|?{\n" +
    "  $_.DisplayName -and !$_.SystemComponent -and\n" +
    "  $_.DisplayName -notmatch '^(KB\\d|Update |Security Update|Hotfix)'\n" +
    "}|%{\n" +
    "  $x=''\n" +
    "  if($_.DisplayIcon){$x=($_.DisplayIcon -split ',')[0].Trim('\"').Trim()}\n" +
    "  if($x -match '\\.exe$' -and $x -notmatch '(msiexec|rundll32)'){[pscustomobject]@{n=$_.DisplayName.Trim();a='';x=$x}}\n" +
    "}|?{$_}\n" +
    // Part 2: AppX packages (UWP/MSIX with AUMIDs)
    "$appx=@()\n" +
    "try{\n" +
    "  $pkgs=Get-AppxPackage -PackageTypeFilter Main|?{$_.SignatureKind -ne 'System' -and !$_.IsFramework}\n" +
    "  foreach($p in $pkgs){\n" +
    "    try{\n" +
    "      $m=(Get-AppxPackageManifest $p).Package.Applications.Application\n" +
    "      if($m){foreach($app in $m){\n" +
    "        $aid=$p.PackageFamilyName+'!'+$app.Id\n" +
    "        $dn=$p.Name -replace '^Microsoft\\.','' -replace '([a-z])([A-Z])','$1 $2'\n" +
    "        $appx+=[pscustomobject]@{n=$dn;a=$aid;x=''}\n" +
    "      }}\n" +
    "    }catch{}\n" +
    "  }\n" +
    "}catch{}\n" +
    "$all=@($reg)+@($appx)|Sort-Object n -Unique\n" +
    "if($all.Count -gt 0){$all|ConvertTo-Json -Compress}else{'[]'}";

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 15_000 },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });

  const raw = JSON.parse(stdout.trim() || "[]");
  const items: Array<{ n: string; a: string; x: string }> = Array.isArray(raw)
    ? raw
    : [raw];

  const byName = new Map<string, string>();
  const aumidByBundleId = new Map<string, string>();
  const installed: InstalledApp[] = [];

  for (const { n: displayName, a: aumid, x: targetPath } of items) {
    if (!displayName) continue;
    if (!aumid && !targetPath) continue;

    let bundleId: string;
    if (aumid) {
      // UWP/MSIX app
      bundleId = normalizeBundleId(aumid, targetPath);
      aumidByBundleId.set(bundleId, aumid);
    } else {
      // Traditional Win32 app
      bundleId = targetPath.toLowerCase();
    }

    byName.set(displayName.toLowerCase(), bundleId);
    installed.push({ bundleId, displayName, path: aumid || targetPath });
  }

  return { byName, aumidByBundleId, installed, lastUpdated: Date.now() };
}

/**
 * Ensure the AUMID cache is populated. Returns silently on failure.
 */
async function ensureAumidCache(): Promise<void> {
  const now = Date.now();
  if (_aumidCache && now - _aumidCache.lastUpdated < AUMID_CACHE_TTL) return;
  if (now - _aumidLastFail < AUMID_FAIL_COOLDOWN) return;

  try {
    _aumidCache = await scanInstalledApps();
  } catch {
    _aumidLastFail = now;
  }
}

/**
 * Fuzzy-match a display name to a bundleId in the AUMID cache.
 * Supports substring matching in both directions (official logic).
 */
function fuzzyLookupBundleId(query: string): string | null {
  if (!_aumidCache) return null;
  const q = query.toLowerCase().replace(/\.exe$/i, "").trim();

  // Exact match
  const exact = _aumidCache.byName.get(q);
  if (exact) return exact;

  // Substring match (best score)
  let best: { bundleId: string; score: number } | null = null;
  for (const [name, bundleId] of _aumidCache.byName) {
    let score: number | undefined;
    if (name.includes(q)) {
      score = 10000 - name.length; // prefer shorter names (more specific)
    } else if (q.includes(name)) {
      score = name.length; // prefer longer matches
    }
    if (score !== undefined && (!best || score > best.score)) {
      best = { bundleId, score };
    }
  }
  return best?.bundleId ?? null;
}

/**
 * Check if a bundleId looks like an AUMID (UWP package format).
 */
function isAumidFormat(bundleId: string): boolean {
  // PackageFamilyName!AppId or PackageName_hash
  return /^[\w.-]+[_!][\w]+/.test(bundleId);
}

/**
 * Launch an app by AUMID via shell:AppsFolder.
 */
async function launchByAumid(aumid: string): Promise<void> {
  shellOpen(`shell:AppsFolder\\${aumid}`);
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createWindowsExecutor(opts: {
  logger: Logger;
  getMouseAnimationEnabled: () => boolean;
  getHideBeforeActionEnabled: () => boolean;
}): ComputerExecutor {
  const { logger, getMouseAnimationEnabled, getHideBeforeActionEnabled } = opts;

  return {
    capabilities: {
      screenshotFiltering: "none", // Windows can't filter windows from screenshots
      platform: "win32",
      hostBundleId: WIN_HOST_BUNDLE_ID,
      teachMode: false,
    },

    // ── Pre-action sequence ───────────────────────────────────────────────

    async prepareForAction(
      allowlistBundleIds: string[],
      _displayId?: number,
    ): Promise<string[]> {
      logger.debug(`[executor] prepareForAction allowlist=${JSON.stringify(allowlistBundleIds)}`);
      if (!getHideBeforeActionEnabled()) {
        return [];
      }

      // Normalize all bundleIds to uppercase exe filenames for comparison.
      // bundleIds can be full paths ("c:\...\weixin.exe") or plain names
      // ("WEIXIN.EXE") — bundleIdToExeName handles both.
      const allowSet = new Set(
        allowlistBundleIds.map((id) => bundleIdToExeName(id)),
      );
      // Always allow explorer.exe (desktop/taskbar)
      allowSet.add(EXPLORER_EXE);
      // Allow the host process
      allowSet.add(bundleIdToExeName(WIN_HOST_BUNDLE_ID));

      const running = nativeListRunningApps();
      const toHide = running
        .filter(
          (app) =>
            !allowSet.has(bundleIdToExeName(app.bundleId)) &&
            !isSystemProcess(app.bundleId) &&
            !isExplorer(app.bundleId),
        )
        .map((app) => app.bundleId);

      if (toHide.length > 0) {
        logger.debug(`[executor] hiding ${toHide.length} windows: ${toHide.join(", ")}`);
        hideWindows(toHide);
      }

      // Activate the first allowed app so our host isn't frontmost
      for (const id of allowlistBundleIds) {
        if (activateWindow(id)) {
          logger.debug(`[executor] activated window: ${id}`);
          break;
        }
      }

      return toHide;
    },

    async previewHideSet(
      allowlistBundleIds: string[],
      _displayId?: number,
    ): Promise<Array<{ bundleId: string; displayName: string }>> {
      const allowSet = new Set(
        allowlistBundleIds.map((id) => bundleIdToExeName(id)),
      );
      allowSet.add(EXPLORER_EXE);
      allowSet.add(bundleIdToExeName(WIN_HOST_BUNDLE_ID));

      const running = nativeListRunningApps();
      return running.filter(
        (app) =>
          !allowSet.has(bundleIdToExeName(app.bundleId)) &&
          !isSystemProcess(app.bundleId) &&
          !isExplorer(app.bundleId),
      );
    },

    // ── Display ───────────────────────────────────────────────────────────

    async getDisplaySize(displayId?: number): Promise<DisplayGeometry> {
      return getMonitorGeometry(displayId);
    },

    async listDisplays(): Promise<DisplayGeometry[]> {
      return listMonitors();
    },

    async findWindowDisplays(
      bundleIds: string[],
    ): Promise<Array<{ bundleId: string; displayIds: number[] }>> {
      return nativeFindWindowDisplays(bundleIds);
    },

    async resolvePrepareCapture(opts: {
      allowedBundleIds: string[];
      preferredDisplayId?: number;
      autoResolve: boolean;
      doHide?: boolean;
    }): Promise<ResolvePrepareCaptureResult> {
      let hidden: string[] = [];

      // Hide non-allowlisted apps if requested
      if (opts.doHide) {
        hidden = await this.prepareForAction(
          opts.allowedBundleIds,
          opts.preferredDisplayId,
        );
      }

      // Capture screenshot
      try {
        const t0 = performance.now();
        const screenshot = await captureMonitor(opts.preferredDisplayId);
        logger.debug(`[executor] resolvePrepareCapture screenshot ${screenshot.width}x${screenshot.height} in ${(performance.now() - t0).toFixed(0)}ms`);
        return {
          ...screenshot,
          hidden,
        };
      } catch (err) {
        const geo = getMonitorGeometry(opts.preferredDisplayId);
        return {
          base64: "",
          width: 0,
          height: 0,
          displayWidth: geo.width,
          displayHeight: geo.height,
          displayId: geo.displayId,
          originX: geo.originX,
          originY: geo.originY,
          hidden,
          captureError: err instanceof Error ? err.message : String(err),
        };
      }
    },

    // ── Screenshot ────────────────────────────────────────────────────────

    async screenshot(opts: {
      allowedBundleIds: string[];
      displayId?: number;
    }): Promise<ScreenshotResult> {
      const t0 = performance.now();
      const result = await captureMonitor(opts.displayId);
      logger.debug(`[executor] screenshot ${result.width}x${result.height} display=${result.displayId} in ${(performance.now() - t0).toFixed(0)}ms`);
      return result;
    },

    async zoom(
      regionLogical: { x: number; y: number; w: number; h: number },
      _allowedBundleIds: string[],
      displayId?: number,
    ): Promise<{ base64: string; width: number; height: number }> {
      logger.debug(`[executor] zoom region=(${regionLogical.x},${regionLogical.y},${regionLogical.w},${regionLogical.h})`);
      const geo = getMonitorGeometry(displayId);
      // Compute target dimensions for the zoomed region
      const { targetImageSize, API_RESIZE_PARAMS } = await import(
        "../upstream/imageResize.js"
      );
      const physW = Math.round(regionLogical.w * geo.scaleFactor);
      const physH = Math.round(regionLogical.h * geo.scaleFactor);
      const [outW, outH] = targetImageSize(physW, physH, API_RESIZE_PARAMS);

      return captureRegion(
        regionLogical.x,
        regionLogical.y,
        regionLogical.w,
        regionLogical.h,
        outW,
        outH,
        75,
        displayId,
      );
    },

    // ── Keyboard ──────────────────────────────────────────────────────────

    async key(keySequence: string, repeat?: number): Promise<void> {
      const n = repeat ?? 1;
      logger.debug(`[executor] key "${keySequence}" repeat=${n}`);
      for (let i = 0; i < n; i++) {
        if (i > 0) await sleep(8);
        keyTap(keySequence);
      }
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      logger.debug(`[executor] holdKey keys=${JSON.stringify(keyNames)} duration=${durationMs}ms`);
      const pressed: string[] = [];
      try {
        for (const k of keyNames) {
          keyToggle(k, "press");
          pressed.push(k);
        }
        await sleep(durationMs);
      } finally {
        for (const k of pressed.reverse()) {
          try {
            keyToggle(k, "release");
          } catch {
            // swallow — best-effort release
          }
        }
      }
    },

    async type(text: string, opts: { viaClipboard: boolean }): Promise<void> {
      const method = (opts.viaClipboard || /[^\x00-\x7F]/.test(text)) ? "clipboard" : "robotjs";
      logger.debug(`[executor] type len=${text.length} method=${method}`);
      if (method === "clipboard") {
        await typeViaClipboard(text);
        return;
      }
      typeString(text);
    },

    async typePaced(text: string, delayMs: number): Promise<void> {
      logger.debug(`[executor] typePaced len=${text.length} delay=${delayMs}ms`);
      // Non-ASCII → clipboard paste (IME bypass), same as type()
      if (/[^\x00-\x7F]/.test(text)) {
        await typeViaClipboard(text);
        return;
      }
      await typeStringPaced(text, delayMs);
    },

    // ── Clipboard ─────────────────────────────────────────────────────────

    async readClipboard(): Promise<string> {
      logger.debug("[executor] readClipboard");
      return nativeReadClipboard();
    },

    async writeClipboard(text: string): Promise<void> {
      logger.debug(`[executor] writeClipboard len=${text.length}`);
      return nativeWriteClipboard(text);
    },

    // ── Mouse ─────────────────────────────────────────────────────────────

    async moveMouse(x: number, y: number): Promise<void> {
      logger.debug(`[executor] moveMouse (${x},${y})`);
      await moveAndSettle(x, y);
    },

    async click(
      x: number,
      y: number,
      button: "left" | "right" | "middle",
      count: 1 | 2 | 3,
      modifiers?: string[],
    ): Promise<void> {
      logger.debug(`[executor] click (${x},${y}) button=${button} count=${count}${modifiers?.length ? ` mods=${modifiers.join("+")}` : ""}`);
      await moveAndSettle(x, y);

      if (modifiers && modifiers.length > 0) {
        // Press modifiers
        for (const m of modifiers) {
          keyToggle(m, "press");
        }
        try {
          nativeMouseClick(button, count);
        } finally {
          // Release modifiers in reverse
          for (const m of [...modifiers].reverse()) {
            try {
              keyToggle(m, "release");
            } catch {
              // best-effort
            }
          }
        }
      } else {
        nativeMouseClick(button, count);
      }
    },

    async mouseDown(): Promise<void> {
      logger.debug("[executor] mouseDown");
      mouseToggle("press", "left");
    },

    async mouseUp(): Promise<void> {
      logger.debug("[executor] mouseUp");
      mouseToggle("release", "left");
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      return getMousePos();
    },

    async drag(
      from: { x: number; y: number } | undefined,
      to: { x: number; y: number },
    ): Promise<void> {
      logger.debug(`[executor] drag from=${from ? `(${from.x},${from.y})` : "current"} to=(${to.x},${to.y})`);
      if (from !== undefined) {
        await moveAndSettle(from.x, from.y);
      }
      mouseToggle("press", "left");
      await sleep(MOVE_SETTLE_MS);
      try {
        await animatedMove(to.x, to.y, getMouseAnimationEnabled());
      } finally {
        mouseToggle("release", "left");
      }
    },

    async scroll(
      x: number,
      y: number,
      dx: number,
      dy: number,
    ): Promise<void> {
      logger.debug(`[executor] scroll (${x},${y}) dx=${dx} dy=${dy}`);
      await moveAndSettle(x, y);
      if (dy !== 0) {
        nativeScrollMouse(
          Math.abs(dy),
          dy > 0 ? "down" : "up",
        );
      }
      if (dx !== 0) {
        nativeScrollMouse(
          Math.abs(dx),
          dx > 0 ? "right" : "left",
        );
      }
    },

    // ── App management ────────────────────────────────────────────────────

    async getFrontmostApp(): Promise<FrontmostApp | null> {
      const info = getForegroundWindowInfo();
      if (!info) return null;
      const app = {
        bundleId: info.exePath.toLowerCase(),
        displayName: extractAppName(info.title, info.exeName),
      };
      logger.debug(`[executor] getFrontmostApp → ${app.displayName} (${info.exeName})`);
      return app;
    },

    async appUnderPoint(
      x: number,
      y: number,
    ): Promise<{ bundleId: string; displayName: string } | null> {
      const info = getWindowFromPoint(x, y);
      if (!info) return null;
      return {
        bundleId: info.exePath.toLowerCase(),
        displayName: extractAppName(info.title, info.exeName),
      };
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      // Merge AUMID-scanned apps (comprehensive: registry + AppX) with
      // running apps (catches portable / unregistered apps).
      await ensureAumidCache();

      const byId = new Map<string, InstalledApp>();

      if (_aumidCache) {
        for (const app of _aumidCache.installed) {
          if (!isSystemProcess(app.bundleId)) {
            byId.set(app.bundleId, app);
          }
        }
      }

      // Running apps fill gaps (portable / unregistered apps)
      const visibleWindows = listVisibleWindows();
      for (const w of visibleWindows) {
        const id = w.exePath.toLowerCase();
        if (!byId.has(id) && !isSystemProcess(w.exeName)) {
          byId.set(id, {
            bundleId: id,
            displayName: extractAppName(w.title, w.exeName),
            path: w.exePath,
          });
        }
      }

      return Array.from(byId.values());
    },

    async getAppIcon(_path: string): Promise<string | undefined> {
      // No icon extraction on Windows MVP. The approval dialog
      // falls back to a grey box when undefined.
      return undefined;
    },

    async listRunningApps(): Promise<RunningApp[]> {
      return nativeListRunningApps().filter(
        (app) => !isSystemProcess(app.bundleId) && !isExplorer(app.bundleId),
      );
    },

    async openApp(bundleId: string): Promise<void> {
      logger.info(`[executor] openApp "${bundleId}"`);
      // Try to activate an existing window first
      if (activateWindow(bundleId)) {
        logger.debug(`[executor] openApp → activated existing window`);
        return;
      }

      // If it's an AUMID, check cache and launch via shell:AppsFolder
      await ensureAumidCache();
      const aumid = _aumidCache?.aumidByBundleId.get(bundleId);
      if (aumid) {
        await launchByAumid(aumid);
        return;
      }

      // If the bundleId itself looks like an AUMID, try launching directly
      if (isAumidFormat(bundleId)) {
        await launchByAumid(bundleId);
        return;
      }

      // If it's a full path or exe name, launch directly
      if (bundleId.includes("\\") || /^[a-z]:/i.test(bundleId)) {
        shellOpen(bundleId);
        return;
      }

      // Try fuzzy lookup by display name
      const resolved = fuzzyLookupBundleId(bundleId);
      if (resolved && resolved !== bundleId) {
        return this.openApp(resolved);
      }

      // Fallback: try to open as-is
      shellOpen(bundleId);
    },
  };
}
