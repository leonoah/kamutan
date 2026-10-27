import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
  collection: vi.fn((_db: unknown, path: string) => ({ kind: "col", path })),
  doc: vi.fn((_db: unknown, path: string) => ({ kind: "doc", path })),
  where: vi.fn((f: string, op: string, v: unknown) => ({ t: "where", f, op, v })),
  orderBy: vi.fn((f: string, d: string) => ({ t: "orderBy", f, d })),
  limit: vi.fn((n: number) => ({ t: "limit", n })),
  query: vi.fn((ref: unknown, ...c: unknown[]) => ({ ref, c })),
  onSnapshot: vi.fn(),
}));
vi.mock("firebase/firestore", () => fs);

const st = vi.hoisted(() => ({ ref: vi.fn((_s: unknown, p: string) => ({ fullPath: p })), uploadBytesResumable: vi.fn() }));
vi.mock("firebase/storage", () => st);

import { createFirebaseUploads, createFirestoreRealtime, toIso } from "./firebaseBackend";
import { UploadCanceledError } from "./types";
import type { Firestore } from "firebase/firestore";
import type { FirebaseStorage } from "firebase/storage";

const ts = (iso: string) => ({ toDate: () => new Date(iso) });
const snapOf = (docs: { id: string; data: Record<string, unknown> }[]) => ({
  docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
});

beforeEach(() => vi.clearAllMocks());

describe("Firebase Storage resumable uploads", () => {
  function fakeTask() {
    const h: { next?: (s: unknown) => void; error?: (e: unknown) => void; complete?: () => void } = {};
    return {
      h,
      task: {
        on: vi.fn((_e: string, n: (s: unknown) => void, e: (x: unknown) => void, c: () => void) => {
          Object.assign(h, { next: n, error: e, complete: c });
        }),
        pause: vi.fn(() => true),
        resume: vi.fn(() => true),
        cancel: vi.fn(() => true),
      },
    };
  }

  it("uploads to the API-issued path with its contentType and reports real progress", async () => {
    const { h, task } = fakeTask();
    st.uploadBytesResumable.mockReturnValue(task);
    const onProgress = vi.fn();
    const file = new Blob(["%PDF-"]);
    const handle = createFirebaseUploads({} as FirebaseStorage).start("orgs/o1/uploads/u1/f1", file, "application/pdf", onProgress);

    expect(st.ref).toHaveBeenCalledWith({}, "orgs/o1/uploads/u1/f1");
    expect(st.uploadBytesResumable).toHaveBeenCalledWith({ fullPath: "orgs/o1/uploads/u1/f1" }, file, { contentType: "application/pdf" });
    h.next!({ bytesTransferred: 512, totalBytes: 1024, state: "running" });
    h.next!({ bytesTransferred: 512, totalBytes: 1024, state: "paused" });
    expect(onProgress.mock.calls).toEqual([
      [512, 1024, "running"],
      [512, 1024, "paused"],
    ]);

    handle.pause();
    handle.resume();
    expect(task.pause).toHaveBeenCalled();
    expect(task.resume).toHaveBeenCalled();
    h.complete!();
    await expect(handle.done).resolves.toBeUndefined();
  });

  it("maps storage/canceled to UploadCanceledError and passes other errors through", async () => {
    const a = fakeTask();
    st.uploadBytesResumable.mockReturnValue(a.task);
    const up = createFirebaseUploads({} as FirebaseStorage);
    const h1 = up.start("p", new Blob(["x"]), "image/png", vi.fn());
    h1.cancel();
    expect(a.task.cancel).toHaveBeenCalled();
    a.h.error!({ code: "storage/canceled" });
    await expect(h1.done).rejects.toBeInstanceOf(UploadCanceledError);

    const b = fakeTask();
    st.uploadBytesResumable.mockReturnValue(b.task);
    const h2 = up.start("p", new Blob(["x"]), "image/png", vi.fn());
    b.h.error!({ code: "storage/unauthorized" });
    await expect(h2.done).rejects.toMatchObject({ code: "storage/unauthorized" });
  });
});

describe("Firestore realtime", () => {
  const db = {} as Firestore;

  it("jobs: queries jobs where orgId == X (and projectId), newest first, and converts Timestamps", () => {
    const onData = vi.fn();
    const off = vi.fn();
    fs.onSnapshot.mockImplementation((_q: unknown, next: (s: unknown) => void) => {
      next(snapOf([{ id: "j1", data: { orgId: "o1", status: "running", progress: 40, createdAt: ts("2026-10-12T08:00:00Z") } }]));
      return off;
    });
    const unsub = createFirestoreRealtime(db).jobs("o1", "p1", onData, vi.fn());

    expect(fs.collection).toHaveBeenCalledWith(db, "jobs");
    expect(fs.where).toHaveBeenNthCalledWith(1, "orgId", "==", "o1");
    expect(fs.where).toHaveBeenNthCalledWith(2, "projectId", "==", "p1");
    expect(fs.orderBy).toHaveBeenCalledWith("createdAt", "desc");
    expect(onData).toHaveBeenCalledWith([
      { id: "j1", orgId: "o1", status: "running", progress: 40, createdAt: "2026-10-12T08:00:00.000Z" },
    ]);
    unsub();
    expect(off).toHaveBeenCalled();
  });

  it("jobs: normalizes the Firestore progress object { stage, pct } to a number + stage (no NaN%)", () => {
    const onData = vi.fn();
    fs.onSnapshot.mockImplementation((_q: unknown, next: (s: unknown) => void) => {
      next(
        snapOf([
          { id: "j1", data: { orgId: "o1", status: "running", progress: { stage: "render", pct: 42.4 }, createdAt: ts("2026-10-12T08:00:00Z") } },
          { id: "j2", data: { orgId: "o1", status: "queued", createdAt: ts("2026-10-12T08:00:00Z") } },
          { id: "j3", data: { orgId: "o1", status: "running", progress: 40, createdAt: ts("2026-10-12T08:00:00Z") } },
        ]),
      );
      return vi.fn();
    });
    createFirestoreRealtime(db).jobs("o1", null, onData, vi.fn());
    const [j1, j2, j3] = onData.mock.calls[0]![0] as { progress: number; stage?: string }[];
    expect(j1).toMatchObject({ progress: 42.4, stage: "render" });
    expect(j2!.progress).toBe(0);
    expect(j3!.progress).toBe(40);
  });

  it("jobs without a project filter only constrain orgId (rules require it)", () => {
    fs.onSnapshot.mockReturnValue(vi.fn());
    createFirestoreRealtime(db).jobs("o1", null, vi.fn(), vi.fn());
    expect(fs.where).toHaveBeenCalledTimes(1);
  });

  it("sheetSets listens under orgs/{orgId}/projects/{projectId}/sheetSets", () => {
    fs.onSnapshot.mockReturnValue(vi.fn());
    createFirestoreRealtime(db).sheetSets("o1", "p1", vi.fn(), vi.fn());
    expect(fs.collection).toHaveBeenCalledWith(db, "orgs/o1/projects/p1/sheetSets");
  });

  it("sheets joins each sheet with a listener on its current version and cleans up", () => {
    const listeners = new Map<string, (s: unknown) => void>();
    const offs: ReturnType<typeof vi.fn>[] = [];
    fs.onSnapshot.mockImplementation((ref: { path: string }, next: (s: unknown) => void) => {
      listeners.set(ref.path, next);
      const off = vi.fn();
      offs.push(off);
      return off;
    });
    const onData = vi.fn();
    const unsub = createFirestoreRealtime(db).sheets("o1", "p1", onData, vi.fn());

    listeners.get("orgs/o1/projects/p1/sheets")!(
      snapOf([{ id: "s1", data: { logicalKey: "E-01", sheetSetId: "set1", currentVersionId: "v1" } }]),
    );
    expect(fs.doc).toHaveBeenCalledWith(db, "orgs/o1/projects/p1/sheets/s1/versions/v1");
    listeners.get("orgs/o1/projects/p1/sheets/s1/versions/v1")!({
      id: "v1",
      exists: () => true,
      data: () => ({ sheetId: "s1", versionNo: 1, status: "processing", createdAt: ts("2026-10-12T08:00:00Z") }),
    });
    expect(onData).toHaveBeenLastCalledWith([
      {
        sheet: { id: "s1", logicalKey: "E-01", sheetSetId: "set1", currentVersionId: "v1" },
        version: { id: "v1", sheetId: "s1", versionNo: 1, status: "processing", createdAt: "2026-10-12T08:00:00.000Z" },
      },
    ]);
    unsub();
    offs.forEach((o) => expect(o).toHaveBeenCalled());
  });

  it("Sprint 3: boqState reads the project doc's `boq` field; boqBuild listens on boqBuilds/{id}", () => {
    const listeners = new Map<string, (s: unknown) => void>();
    fs.onSnapshot.mockImplementation((ref: { path: string }, next: (s: unknown) => void) => {
      listeners.set(ref.path, next);
      return vi.fn();
    });
    const onState = vi.fn();
    const onBuild = vi.fn();
    const rt = createFirestoreRealtime(db);
    rt.boqState("o1", "p1", onState, vi.fn());
    rt.boqBuild("o1", "p1", "b1", onBuild, vi.fn());
    listeners.get("orgs/o1/projects/p1")!({ id: "p1", exists: () => true, data: () => ({ boq: { latestBuildId: "b1", builtAt: ts("2026-10-14T08:00:00Z"), stale: true } }) });
    expect(onState).toHaveBeenLastCalledWith({ latestBuildId: "b1", builtAt: "2026-10-14T08:00:00.000Z", stale: true });
    listeners.get("orgs/o1/projects/p1")!({ id: "p1", exists: () => true, data: () => ({ name: "x" }) });
    expect(onState).toHaveBeenLastCalledWith(null);
    listeners.get("orgs/o1/projects/p1/boqBuilds/b1")!({ id: "b1", exists: () => true, data: () => ({ status: "running", startedAt: ts("2026-10-14T08:00:00Z"), progress: 40 }) });
    expect(onBuild).toHaveBeenLastCalledWith({ id: "b1", status: "running", progress: 40, startedAt: "2026-10-14T08:00:00.000Z", finishedAt: null });
    listeners.get("orgs/o1/projects/p1/boqBuilds/b1")!({ id: "b1", exists: () => false, data: () => ({}) });
    expect(onBuild).toHaveBeenLastCalledWith(null);
  });

  it("toIso handles Timestamp, string and missing values", () => {
    expect(toIso(ts("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(toIso("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
    expect(toIso(undefined)).toBe("");
  });
});
