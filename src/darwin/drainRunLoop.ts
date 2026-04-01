/**
 * Copied from Claude Code src/utils/computerUse/drainRunLoop.ts
 * Change: import from shims
 */

import { logForDebugging, withResolvers } from "./shims.js";
import { requireComputerUseSwift } from "./swiftLoader.js";

let pump: ReturnType<typeof setInterval> | undefined;
let pending = 0;

function drainTick(cu: ReturnType<typeof requireComputerUseSwift>): void {
  cu._drainMainRunLoop();
}

function retain(): void {
  pending++;
  if (pump === undefined) {
    pump = setInterval(drainTick, 1, requireComputerUseSwift());
    logForDebugging("[drainRunLoop] pump started", { level: "verbose" });
  }
}

function release(): void {
  pending--;
  if (pending <= 0 && pump !== undefined) {
    clearInterval(pump);
    pump = undefined;
    logForDebugging("[drainRunLoop] pump stopped", { level: "verbose" });
    pending = 0;
  }
}

const TIMEOUT_MS = 30_000;

function timeoutReject(reject: (e: Error) => void): void {
  reject(new Error(`computer-use native call exceeded ${TIMEOUT_MS}ms`));
}

export const retainPump = retain;
export const releasePump = release;

export async function drainRunLoop<T>(fn: () => Promise<T>): Promise<T> {
  retain();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = fn();
    work.catch(() => {});
    const timeout = withResolvers<never>();
    timer = setTimeout(timeoutReject, TIMEOUT_MS, timeout.reject);
    return await Promise.race([work, timeout.promise]);
  } finally {
    clearTimeout(timer);
    release();
  }
}
