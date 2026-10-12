import { useBackend } from "@/api/client";
import type { Job, Sheet, SheetSet, SheetVersion } from "@/api/types";
import { useSubscription } from "@/lib/useSubscription";

/** Live jobs of the org (optionally one project) — Firestore `jobs where orgId == X`. */
export function useLiveJobs(orgId: string | null, projectId: string | null = null) {
  const { realtime } = useBackend();
  return useSubscription<Job[]>(
    ["live", "jobs", orgId, projectId],
    orgId ? (onData, onError) => realtime.jobs(orgId, projectId, onData, onError) : null,
  );
}

export function useLiveSheetSets(orgId: string | null, projectId: string) {
  const { realtime } = useBackend();
  return useSubscription<SheetSet[]>(
    ["live", "sheetSets", orgId, projectId],
    orgId ? (onData, onError) => realtime.sheetSets(orgId, projectId, onData, onError) : null,
  );
}

export function useLiveSheets(orgId: string | null, projectId: string) {
  const { realtime } = useBackend();
  return useSubscription<{ sheet: Sheet; version: SheetVersion | null }[]>(
    ["live", "sheets", orgId, projectId],
    orgId ? (onData, onError) => realtime.sheets(orgId, projectId, onData, onError) : null,
  );
}

export const isActiveJob = (j: Job) => j.status === "queued" || j.status === "running";
