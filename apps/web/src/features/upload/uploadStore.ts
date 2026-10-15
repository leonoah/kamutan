import { create } from "zustand";
import { ApiError, UploadCanceledError, type Backend, type FileKind, type UploadHandle } from "@/api/types";
import { validateFileDeep, type FileErrorCode } from "./validation";

export type UploadStatus =
  | "queued" // waiting for a slot
  | "preparing" // POST /uploads (token + storage path)
  | "uploading" // uploadBytesResumable running
  | "paused"
  | "finalizing" // POST /sheet-sets (verify + start ingest)
  | "done"
  | "error"
  | "canceled"
  | "rejected"; // failed client-side validation

export type UploadErrorCode = FileErrorCode | "network" | "expired" | "server";

export interface UploadEntry {
  id: string;
  projectId: string;
  name: string;
  size: number;
  kind: FileKind | null;
  status: UploadStatus;
  loaded: number;
  errorCode: UploadErrorCode | null;
  file: File;
  /** Set after finalize: ingest job to follow live, and whether the bytes were already in the project. */
  result?: { jobId: string; sheetSetId: string; deduplicated: boolean };
}

interface UploadState {
  entries: UploadEntry[];
  addFiles: (backend: Backend, projectId: string, files: File[]) => Promise<void>;
  pause: (id: string) => void;
  resume: (id: string) => void;
  cancel: (id: string) => void;
  retry: (backend: Backend, id: string) => void;
  remove: (id: string) => void;
  clearFinished: (projectId: string) => void;
}

const CONCURRENCY = 3;
const ACTIVE: UploadStatus[] = ["preparing", "uploading", "finalizing"];
const handles = new Map<string, UploadHandle>();
const canceledBeforeStart = new Set<string>();
let entrySeq = 0;

function mapError(err: unknown): UploadErrorCode {
  if (err instanceof ApiError) {
    if (err.code === "unsupported_file_type") return "unsupported";
    if (err.code === "payload_too_large") return "too_large";
    if (err.code === "upload_expired" || err.code === "upload_missing") return "expired";
    return err.status === 0 ? "network" : "server";
  }
  return "network";
}

export const useUploadStore = create<UploadState>((set, get) => {
  const patch = (id: string, p: Partial<UploadEntry>) =>
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? { ...e, ...p } : e)) }));
  const statusOf = (id: string) => get().entries.find((e) => e.id === id)?.status;

  async function runOne(backend: Backend, entry: UploadEntry) {
    patch(entry.id, { status: "preparing", loaded: 0, errorCode: null });
    try {
      const target = await backend.api.createUpload(entry.projectId, { filename: entry.name, sizeBytes: entry.size });
      if (canceledBeforeStart.delete(entry.id)) throw new UploadCanceledError();
      const handle = backend.uploads.start(target.storagePath, entry.file, target.contentType, (loaded, _total, state) => {
        if (statusOf(entry.id) === "canceled") return;
        patch(entry.id, { loaded, status: state === "paused" ? "paused" : "uploading" });
      });
      handles.set(entry.id, handle);
      await handle.done;
      handles.delete(entry.id);
      patch(entry.id, { status: "finalizing", loaded: entry.size });
      const res = await backend.api.finalizeUpload(entry.projectId, { uploadToken: target.uploadToken, name: entry.name });
      patch(entry.id, {
        status: "done",
        result: { jobId: res.jobId, sheetSetId: res.sheetSet.id, deduplicated: res.deduplicated },
      });
    } catch (err) {
      handles.delete(entry.id);
      if (err instanceof UploadCanceledError) patch(entry.id, { status: "canceled", errorCode: null });
      else patch(entry.id, { status: "error", errorCode: mapError(err) });
    }
  }

  function pump(backend: Backend) {
    const { entries } = get();
    let active = entries.filter((e) => ACTIVE.includes(e.status)).length;
    for (const e of entries) {
      if (active >= CONCURRENCY) break;
      if (e.status === "queued") {
        active += 1;
        void runOne(backend, e).then(() => pump(backend));
      }
    }
  }

  return {
    entries: [],
    async addFiles(backend, projectId, files) {
      const existing = get().entries.filter(
        (e) => e.projectId === projectId && !["rejected", "canceled", "error"].includes(e.status),
      );
      const seen = new Set(existing.map((e) => `${e.name}:${e.size}`));
      const fresh: UploadEntry[] = [];
      for (const file of files) {
        const key = `${file.name}:${file.size}`;
        const base = { id: `f${++entrySeq}`, projectId, name: file.name, size: file.size, loaded: 0, file };
        if (seen.has(key)) {
          fresh.push({ ...base, kind: null, status: "rejected", errorCode: "duplicate" });
          continue;
        }
        seen.add(key);
        const res = await validateFileDeep(file);
        fresh.push(
          res.ok
            ? { ...base, kind: res.kind, status: "queued", errorCode: null }
            : { ...base, kind: null, status: "rejected", errorCode: res.code },
        );
      }
      set((s) => ({ entries: [...s.entries, ...fresh] }));
      pump(backend);
    },
    pause(id) {
      if (handles.get(id)?.pause()) patch(id, { status: "paused" });
    },
    resume(id) {
      if (handles.get(id)?.resume()) patch(id, { status: "uploading" });
    },
    cancel(id) {
      const st = statusOf(id);
      if (st === "queued") return patch(id, { status: "canceled" });
      if (st === "preparing") canceledBeforeStart.add(id);
      handles.get(id)?.cancel();
      patch(id, { status: "canceled" });
    },
    retry(backend, id) {
      patch(id, { status: "queued", loaded: 0, errorCode: null });
      pump(backend);
    },
    remove(id) {
      handles.get(id)?.cancel();
      handles.delete(id);
      set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
    },
    clearFinished(projectId) {
      set((s) => ({
        entries: s.entries.filter(
          (e) => e.projectId !== projectId || !["done", "rejected", "canceled"].includes(e.status),
        ),
      }));
    },
  };
});
