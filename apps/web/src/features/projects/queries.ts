import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/api/client";
import type { CreateProjectInput } from "@/api/types";

export const useProjects = () => {
  const api = useApi();
  return useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
};

export const useProject = (id: string) => {
  const api = useApi();
  return useQuery({ queryKey: ["projects", id], queryFn: () => api.getProject(id), retry: false });
};

export const useSheetSets = (projectId: string) => {
  const api = useApi();
  return useQuery({ queryKey: ["sheet-sets", projectId], queryFn: () => api.listSheetSets(projectId) });
};

export const useCreateProject = () => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.createProject(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
};
