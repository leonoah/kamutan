import { UploadCanceledError, type RealtimeSource, type UploadHandle, type UploadTransport, type Unsubscribe } from "./types";

/**
 * Sprint 8 (code-splitting): Firestore (~1.3 MB of SDK source, most of the Firebase chunk) and Storage are only needed
 * once a signed-in screen subscribes to live data or uploads a file. These wrappers keep the synchronous
 * `RealtimeSource` / `UploadTransport` contracts while the real implementation (and the SDK chunk behind it) is
 * fetched on first use — so the landing, the login and the first paint of every screen do not wait for it.
 */

const once = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | null = null;
  return () => {
    p ??= load().catch((e: unknown) => {
      p = null; // a failed chunk load (offline) may be retried by the next subscriber
      throw e;
    });
    return p;
  };
};

const REALTIME_METHODS = ["jobs", "sheetSets", "sheets", "boqState", "boqBuild"] as const satisfies readonly (keyof RealtimeSource)[];

/** Every listener returns its Unsubscribe at once; it attaches when the implementation arrives (or reports the load error). */
export function createLazyRealtime(load: () => Promise<RealtimeSource>): RealtimeSource {
  const get = once(load);
  const out = {} as Record<string, unknown>;
  for (const m of REALTIME_METHODS) {
    out[m] = (...args: unknown[]): Unsubscribe => {
      let unsub: Unsubscribe | null = null;
      let stopped = false;
      const onError = args.find((a, i) => i === args.length - 1 && typeof a === "function") as ((e: Error) => void) | undefined;
      void get().then(
        (src) => {
          if (stopped) return;
          unsub = (src[m] as (...a: unknown[]) => Unsubscribe)(...args);
        },
        (e: unknown) => {
          if (!stopped) onError?.(e instanceof Error ? e : new Error(String(e)));
        },
      );
      return () => {
        stopped = true;
        unsub?.();
      };
    };
  }
  return out as unknown as RealtimeSource;
}

/**
 * An upload handle usable before the Storage SDK has loaded: pause / resume / cancel requested meanwhile are applied
 * once the real task exists (a cancel before that never starts the upload).
 */
export function createLazyUploads(load: () => Promise<UploadTransport>): UploadTransport {
  const get = once(load);
  return {
    start(storagePath, file, contentType, onProgress): UploadHandle {
      let real: UploadHandle | null = null;
      let paused = false;
      let canceled = false;
      const done = get().then((t) => {
        if (canceled) throw new UploadCanceledError();
        real = t.start(storagePath, file, contentType, onProgress);
        if (paused) real.pause();
        return real.done;
      });
      return {
        pause: () => (real ? real.pause() : ((paused = true), true)),
        resume: () => (real ? real.resume() : ((paused = false), true)),
        cancel: () => (real ? real.cancel() : ((canceled = true), true)),
        done,
      };
    },
  };
}
