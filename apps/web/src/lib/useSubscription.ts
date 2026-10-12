import { useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { OnError, Unsubscribe } from "@/api/types";

export type Subscribe<T> = (onData: (data: T) => void, onError: OnError) => Unsubscribe;

/**
 * Bridges a push source (Firestore onSnapshot, mock emitter) into the TanStack Query cache:
 * snapshots are written with setQueryData, so any component reading the same key re-renders,
 * and the data survives remounts while the listener is attached elsewhere.
 * Pass `null` to disable (e.g. while orgId is unknown).
 */
export function useSubscription<T>(queryKey: QueryKey, subscribe: Subscribe<T> | null) {
  const qc = useQueryClient();
  const [error, setError] = useState<Error | null>(null);
  const keyHash = JSON.stringify(queryKey);
  const enabled = subscribe !== null;

  useEffect(() => {
    if (!subscribe) return;
    setError(null);
    return subscribe(
      (data) => qc.setQueryData(queryKey, data),
      (err) => setError(err),
    );
    // The subscribe closure is recreated every render; the key fully identifies the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyHash, enabled, qc]);

  const q = useQuery<T>({
    queryKey,
    // Never fetched: data only arrives through setQueryData from the listener.
    queryFn: () => new Promise<T>(() => {}),
    enabled: false,
    staleTime: Infinity,
  });

  return { data: q.data, error, isLoading: enabled && q.data === undefined && !error };
}
