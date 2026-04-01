/**
 * Copied from Claude Code src/utils/computerUse/computerUseLock.ts
 * Change: imports from shims instead of Claude Code internals
 */

import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";
import {
  getSessionId,
  registerCleanup,
  logForDebugging,
  getClaudeConfigHomeDir,
  jsonParse,
  jsonStringify,
  getErrnoCode,
} from "./shims.js";

const LOCK_FILENAME = "computer-use.lock";

let unregisterCleanupFn: (() => void) | undefined;

type ComputerUseLock = {
  readonly sessionId: string;
  readonly pid: number;
  readonly acquiredAt: number;
};

export type AcquireResult =
  | { readonly kind: "acquired"; readonly fresh: boolean }
  | { readonly kind: "blocked"; readonly by: string };

export type CheckResult =
  | { readonly kind: "free" }
  | { readonly kind: "held_by_self" }
  | { readonly kind: "blocked"; readonly by: string };

const FRESH: AcquireResult = { kind: "acquired", fresh: true };
const REENTRANT: AcquireResult = { kind: "acquired", fresh: false };

function isComputerUseLock(value: unknown): value is ComputerUseLock {
  if (typeof value !== "object" || value === null) return false;
  return (
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    "pid" in value &&
    typeof value.pid === "number"
  );
}

function getLockPath(): string {
  return join(getClaudeConfigHomeDir(), LOCK_FILENAME);
}

async function readLock(): Promise<ComputerUseLock | undefined> {
  try {
    const raw = await readFile(getLockPath(), "utf8");
    const parsed: unknown = jsonParse(raw);
    return isComputerUseLock(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tryCreateExclusive(lock: ComputerUseLock): Promise<boolean> {
  try {
    await writeFile(getLockPath(), jsonStringify(lock), { flag: "wx" });
    return true;
  } catch (e: unknown) {
    if (getErrnoCode(e) === "EEXIST") return false;
    throw e;
  }
}

function registerLockCleanup(): void {
  unregisterCleanupFn?.();
  unregisterCleanupFn = registerCleanup(async () => {
    await releaseComputerUseLock();
  });
}

export async function checkComputerUseLock(): Promise<CheckResult> {
  const existing = await readLock();
  if (!existing) return { kind: "free" };
  if (existing.sessionId === getSessionId()) return { kind: "held_by_self" };
  if (isProcessRunning(existing.pid)) {
    return { kind: "blocked", by: existing.sessionId };
  }
  logForDebugging(
    `Recovering stale computer-use lock from session ${existing.sessionId} (PID ${existing.pid})`,
  );
  await unlink(getLockPath()).catch(() => {});
  return { kind: "free" };
}

export function isLockHeldLocally(): boolean {
  return unregisterCleanupFn !== undefined;
}

export async function tryAcquireComputerUseLock(): Promise<AcquireResult> {
  const sessionId = getSessionId();
  const lock: ComputerUseLock = {
    sessionId,
    pid: process.pid,
    acquiredAt: Date.now(),
  };

  await mkdir(getClaudeConfigHomeDir(), { recursive: true });

  if (await tryCreateExclusive(lock)) {
    registerLockCleanup();
    return FRESH;
  }

  const existing = await readLock();

  if (!existing) {
    await unlink(getLockPath()).catch(() => {});
    if (await tryCreateExclusive(lock)) {
      registerLockCleanup();
      return FRESH;
    }
    return { kind: "blocked", by: (await readLock())?.sessionId ?? "unknown" };
  }

  if (existing.sessionId === sessionId) return REENTRANT;

  if (isProcessRunning(existing.pid)) {
    return { kind: "blocked", by: existing.sessionId };
  }

  logForDebugging(
    `Recovering stale computer-use lock from session ${existing.sessionId} (PID ${existing.pid})`,
  );
  await unlink(getLockPath()).catch(() => {});
  if (await tryCreateExclusive(lock)) {
    registerLockCleanup();
    return FRESH;
  }
  return { kind: "blocked", by: (await readLock())?.sessionId ?? "unknown" };
}

export async function releaseComputerUseLock(): Promise<boolean> {
  unregisterCleanupFn?.();
  unregisterCleanupFn = undefined;

  const existing = await readLock();
  if (!existing || existing.sessionId !== getSessionId()) return false;
  try {
    await unlink(getLockPath());
    logForDebugging("Released computer-use lock");
    return true;
  } catch {
    return false;
  }
}
