/**
 * Helpers for non-invasive instrumentation: wrapping instance methods without
 * changing their observable behaviour, and making sure an inspector bug can
 * never break the host application.
 */

import type { ErrorInfo } from "./types";

let warned = false;

/** Run instrumentation code; swallow (and report once) anything it throws. */
export function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn("[rtc-inspector] instrumentation error (further errors suppressed):", err);
    }
  }
}

export function toErrorInfo(err: unknown): ErrorInfo {
  if (err && typeof err === "object") {
    const e = err as { name?: unknown; message?: unknown; errorDetail?: unknown };
    const detail = typeof e.errorDetail === "string" ? ` (${e.errorDetail})` : "";
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: (typeof e.message === "string" ? e.message : String(err)) + detail,
    };
  }
  return { name: "Error", message: String(err) };
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Replace `target[name]` with `factory(original)` as an *own* property, so the
 * prototype stays untouched. Returns a function that restores the previous
 * state exactly.
 */
export function wrapMethod(target: object, name: string, factory: (original: AnyFn) => AnyFn): () => void {
  const original = (target as Record<string, unknown>)[name];
  if (typeof original !== "function") return () => {};
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, name);
  const wrapped = factory(original as AnyFn);
  Object.defineProperty(target, name, { value: wrapped, configurable: true, writable: true, enumerable: false });
  return () => {
    if ((target as Record<string, unknown>)[name] !== wrapped) return; // someone re-wrapped after us
    if (ownDescriptor) Object.defineProperty(target, name, ownDescriptor);
    else delete (target as Record<string, unknown>)[name];
  };
}

export interface AsyncHooks {
  onResolve?: (value: unknown, args: unknown[], startedAt: number) => void;
  onReject?: (error: unknown, args: unknown[], startedAt: number) => void;
}

/**
 * Wrap a promise-returning WebRTC method (which may also be invoked with the
 * legacy `(…, successCallback, failureCallback)` signature) so we observe its
 * outcome while returning exactly what the original returns/resolves/rejects.
 */
export function wrapAsyncMethod(target: object, name: string, now: () => number, hooks: AsyncHooks): () => void {
  return wrapMethod(target, name, (original) =>
    function (this: unknown, ...args: unknown[]) {
      const startedAt = now();
      const callbackIndex = args.findIndex((a) => typeof a === "function");
      if (callbackIndex !== -1) {
        const patched = [...args];
        const success = args[callbackIndex] as AnyFn;
        const failure = args[callbackIndex + 1];
        patched[callbackIndex] = (value: unknown) => {
          safely(() => hooks.onResolve?.(value, args, startedAt));
          return success(value);
        };
        if (typeof failure === "function") {
          patched[callbackIndex + 1] = (error: unknown) => {
            safely(() => hooks.onReject?.(error, args, startedAt));
            return (failure as AnyFn)(error);
          };
        }
        return original.apply(this, patched);
      }
      let result: unknown;
      try {
        result = original.apply(this, args);
      } catch (error) {
        safely(() => hooks.onReject?.(error, args, startedAt));
        throw error;
      }
      if (isThenable(result)) {
        return Promise.resolve(result).then(
          (value) => {
            safely(() => hooks.onResolve?.(value, args, startedAt));
            return value;
          },
          (error: unknown) => {
            safely(() => hooks.onReject?.(error, args, startedAt));
            throw error;
          },
        );
      }
      safely(() => hooks.onResolve?.(result, args, startedAt));
      return result;
    },
  );
}

export const now = (): number =>
  typeof performance !== "undefined" && typeof performance.timeOrigin === "number"
    ? performance.timeOrigin + performance.now()
    : Date.now();

let fallbackCounter = 0;
export function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // randomUUID throws in insecure contexts on some browsers
    }
  }
  fallbackCounter += 1;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${fallbackCounter}`;
}
