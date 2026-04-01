/**
 * Type declarations for @ant/computer-use-swift.
 * These types are inferred from the original executor.ts usage patterns.
 * The actual .node binary is only loaded at runtime on macOS.
 */

declare module "@ant/computer-use-swift" {
  export interface ComputerUseAPI {
    _drainMainRunLoop(): void;

    screenshot: {
      captureExcluding(
        allowedBundleIds: string[],
        quality: number,
        targetW: number,
        targetH: number,
        displayId?: number,
      ): Promise<import("../upstream/executor.js").ScreenshotResult>;

      captureRegion(
        allowedBundleIds: string[],
        x: number,
        y: number,
        w: number,
        h: number,
        outW: number,
        outH: number,
        quality: number,
        displayId?: number,
      ): Promise<{ base64: string; width: number; height: number }>;
    };

    display: {
      getSize(displayId?: number): import("../upstream/executor.js").DisplayGeometry;
      listAll(): import("../upstream/executor.js").DisplayGeometry[];
    };

    apps: {
      prepareDisplay(
        allowlistBundleIds: string[],
        surrogateHost: string,
        displayId?: number,
      ): Promise<{ hidden: string[]; activated?: string }>;

      previewHideSet(
        allowlistBundleIds: string[],
        displayId?: number,
      ): Array<{ bundleId: string; displayName: string }>;

      findWindowDisplays(
        bundleIds: string[],
      ): Array<{ bundleId: string; displayIds: number[] }>;

      appUnderPoint(
        x: number,
        y: number,
      ): { bundleId: string; displayName: string } | null;

      listInstalled(): Promise<import("../upstream/executor.js").InstalledApp[]>;

      iconDataUrl(path: string): string | null;

      listRunning(): import("../upstream/executor.js").RunningApp[];

      open(bundleId: string): Promise<void>;

      unhide(bundleIds: string[]): Promise<void>;
    };

    tcc: {
      checkAccessibility(): boolean;
      checkScreenRecording(): boolean;
    };

    hotkey: {
      registerEscape(onEscape: () => void): boolean;
      unregister(): void;
      notifyExpectedEscape(): void;
    };

    resolvePrepareCapture(
      allowedBundleIds: string[],
      surrogateHost: string,
      quality: number,
      targetW: number,
      targetH: number,
      preferredDisplayId?: number,
      autoResolve?: boolean,
      doHide?: boolean,
    ): Promise<import("../upstream/executor.js").ResolvePrepareCaptureResult>;
  }
}
