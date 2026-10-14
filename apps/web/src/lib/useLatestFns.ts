import { useMemo, useRef } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fns = Record<string, (...args: any[]) => any>;

/**
 * Stable function identities that always call the latest closure ("useEvent" pattern). Lets memoised children
 * (queue cards, BOQ table, drawing pane) skip re-rendering on every page state change — the review loop needs
 * < 100 ms per key press.
 */
export function useLatestFns<T extends Fns>(fns: T): T {
  const ref = useRef(fns);
  ref.current = fns;
  return useMemo(
    () => Object.fromEntries(Object.keys(fns).map((k) => [k, (...a: unknown[]) => ref.current[k]!(...a)])) as T,
    // The key set is fixed per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}
