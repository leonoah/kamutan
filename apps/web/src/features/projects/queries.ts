import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/api/client";
import type { CreateProjectInput, Job, Project, UpdateProjectInput } from "@/api/types";
import { isActiveJob } from "@/features/realtime/hooks";

export const useProjects = (orgId: string) => {
  const api = useApi();
  return useQuery({ queryKey: ["projects", orgId], queryFn: () => api.listProjects(orgId) });
};

export const useProject = (id: string) => {
  const api = useApi();
  return useQuery({ queryKey: ["project", id], queryFn: () => api.getProject(id), retry: false });
};

export const useCreateProject = () => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.createProject(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
};

export const useUpdateProject = () => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateProjectInput }) => api.updateProject(id, patch),
    onSuccess: (_p, { id }) => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["project", id] });
    },
  });
};

export type ProjectPhase = "draft" | "processing" | "review" | "ready" | "archived";

/** UI workflow phase derived from project stats + live jobs (the API has no workflow status field). */
export function projectPhase(p: Project, jobs: Job[] = []): ProjectPhase {
  if (p.status === "archived") return "archived";
  if (jobs.some((j) => j.projectId === p.id && isActiveJob(j))) return "processing";
  const s = p.stats;
  if (!s || s.sheets === 0) return "draft";
  if (s.boqLines === 0) return "processing";
  return s.reviewOpen > 0 ? "review" : "ready";
}

/** % of BOQ rows at level green (מאומת) — by rows, not items (05_ux). */
export function verifiedPct(p: Project): number | null {
  const s = p.stats;
  const total = s ? s.green + s.yellow + s.red : 0;
  return s && total > 0 ? Math.round((s.green / total) * 100) : null;
}

/** Mean progress of the project's active jobs, or null. */
export function activeProgress(projectId: string, jobs: Job[] = []): number | null {
  const active = jobs.filter((j) => j.projectId === projectId && isActiveJob(j));
  return active.length ? Math.round(active.reduce((a, j) => a + j.progress, 0) / active.length) : null;
}
