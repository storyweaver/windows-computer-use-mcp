/**
 * Type declarations for @ant/computer-use-input.
 * Inferred from original executor.ts usage patterns.
 */

declare module "@ant/computer-use-input" {
  export interface ComputerUseInputAPI {
    moveMouse(x: number, y: number, animate: boolean): Promise<void>;
    mouseLocation(): Promise<{ x: number; y: number }>;
    mouseButton(
      button: "left" | "right" | "middle",
      action: "click" | "press" | "release",
      count?: number,
    ): Promise<void>;
    mouseScroll(amount: number, direction: "vertical" | "horizontal"): Promise<void>;
    key(keyName: string, action: "press" | "release"): Promise<void>;
    keys(keyNames: string[]): Promise<void>;
    typeText(text: string): Promise<void>;
    getFrontmostAppInfo(): { bundleId: string; appName: string } | null;
  }

  export type ComputerUseInput =
    | ({ isSupported: true } & ComputerUseInputAPI)
    | { isSupported: false };
}
