import { create } from "zustand";
import type { ApiClient, FileKind } from "@/api/types";
import { validateFileDeep, type FileErrorCode } from "./validation";

export type UploadStatus = "queued" | "uploading" | "done" | "error" | "rejected";

export interface UploadEntry {
  id: string;
  projectId: string;
  name: string;
  size: number;
  kind: FileKind | null;
  status: UploadStatus;
  loaded: number;
  /** rejected → validation code; error → transport failure */
  errorCode: FileErrorCode | "network" | null;
  file: File;
  uploadId?: string;
}

interface UploadState {
  entries: UploadEntry[];
  addFiles: (api: ApiClient, projectId: string, files: File[]) => Promise<void>;
  retry: (api: ApiClient, id: string) => void;
  remove: (id: string) => void;
  clearProject: (projectId: string) => void;
}

const CONCURRENCY = 3;
const controllers = new Map<string, AbortController>();
let entrySeq = 0;

export const useUploadStore = create<UploadState>((set, get) => {
  const patch = (id: string, p: Partial<UploadEntry>) =>
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? { ...e, ...p } : e)) }));

  async function runOne(api: ApiClient, entry: UploadEntry) {
    const ctrl = new AbortController();
    controllers.set(entry.id, ctrl);
    patch(entry.id, { status: "uploading", loaded: 0, errorCode: null });
    try {
      const target = await api.createUpload(entry.projectId, {
        fileName: entry.name,
        sizeBytes: entry.size,
        kind: entry.kind!,
      });
      await api.uploadFile(target, entry.file, (loaded) => patch(entry.id, { loaded }), ctrl.signal);
      patch(entry.id, { status: "done", loaded: entry.size, uploadId: target.uploadId });
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return;
      patch(entry.id, { status: "error", errorCode: "network" });
    } finally {
      controllers.delete(entry.id);
    }
  }

  function pump(api: ApiClient) {
    const { entries } = get();
    let active = entries.filter((e) => e.status === "uploading").length;
    for (const e of entries) {
      if (active >= CONCURRENCY) break;
      if (e.status === "queued") {
        active += 1;
        void runOne(api, e).then(() => pump(api));
      }
    }
  }

  return {
    entries: [],
    async addFiles(api, projectId, files) {
      const existing = get().entries.filter((e) => e.projectId === projectId && e.status !== "rejected");
      const seen = new Set(existing.map((e) => `${e.name}:${e.size}`));
      const newEntries: UploadEntry[] = [];
      for (const file of files) {
        const key = `${file.name}:${file.size}`;
        const base = {
          id: `f${++entrySeq}`,
          projectId,
          name: file.name,
          size: file.size,
          loaded: 0,
          file,
        };
        if (seen.has(key)) {
          newEntries.push({ ...base, kind: null, status: "rejected", errorCode: "duplicate" });
          continue;
        }
        seen.add(key);
        const res = await validateFileDeep(file);
        newEntries.push(
          res.ok
            ? { ...base, kind: res.kind, status: "queued", errorCode: null }
            : { ...base, kind: null, status: "rejected", errorCode: res.code },
        );
      }
      set((s) => ({ entries: [...s.entries, ...newEntries] }));
      pump(api);
    },
    retry(api, id) {
      patch(id, { status: "queued", loaded: 0, errorCode: null });
      pump(api);
    },
    remove(id) {
      controllers.get(id)?.abort();
      set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
    },
    clearProject(projectId) {
      for (const e of get().entries) if (e.projectId === projectId) controllers.get(e.id)?.abort();
      set((s) => ({ entries: s.entries.filter((e) => e.projectId !== projectId) }));
    },
  };
});
