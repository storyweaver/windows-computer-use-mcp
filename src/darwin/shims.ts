/**
 * Shims for Claude Code infrastructure dependencies.
 *
 * The original macOS computer-use code imports from Claude Code's internal
 * modules (debug, sleep, env, etc.). This file provides standalone
 * replacements so the original code runs outside Claude Code.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { createFileLogger } from "../logger.js";

// ── logForDebugging → our file logger ────────────────────────────────────

const logger = createFileLogger("argus");

export function logForDebugging(
  message: string,
  opts?: { level?: string },
): void {
  const level = opts?.level ?? "debug";
  switch (level) {
    case "error":
      logger.error(message);
      break;
    case "warn":
      logger.warn(message);
      break;
    case "info":
      logger.info(message);
      break;
    default:
      logger.debug(message);
  }
}

// ── sleep ────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── execFileNoThrow ─────────────────────────────────────────────────────

export function execFileNoThrow(
  cmd: string,
  args: string[],
  opts?: { input?: string; useCwd?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = execFile(
      cmd,
      args,
      { encoding: "utf-8", timeout: 10000 },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: error ? (error as any).code ?? 1 : 0,
        });
      },
    );
    if (opts?.input !== undefined && proc.stdin) {
      proc.stdin.write(opts.input);
      proc.stdin.end();
    }
  });
}

// ── errorMessage ────────────────────────────────────────────────────────

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── getErrnoCode ────────────────────────────────────────────────────────

export function getErrnoCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    return (e as { code: string }).code;
  }
  return undefined;
}

// ── env.terminal ────────────────────────────────────────────────────────

export const env = {
  terminal: process.env.TERM_PROGRAM ?? undefined,
};

// ── session ID ──────────────────────────────────────────────────────────

const SESSION_ID = `argus-${randomUUID().slice(0, 8)}`;

export function getSessionId(): string {
  return SESSION_ID;
}

// ── config home dir (~/.claude) ─────────────────────────────────────────

export function getClaudeConfigHomeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

// ── withResolvers (Promise.withResolvers polyfill) ───────────────────────

export function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── jsonParse / jsonStringify (no-op wrappers) ──────────────────────────

export const jsonParse = JSON.parse;
export const jsonStringify = JSON.stringify;

// ── registerCleanup ─────────────────────────────────────────────────────

const cleanupFns: Array<() => Promise<void>> = [];

export function registerCleanup(fn: () => Promise<void>): () => void {
  cleanupFns.push(fn);
  return () => {
    const idx = cleanupFns.indexOf(fn);
    if (idx >= 0) cleanupFns.splice(idx, 1);
  };
}

// Run all cleanup fns on exit
process.on("exit", () => {
  for (const fn of cleanupFns) {
    fn().catch(() => {});
  }
});
