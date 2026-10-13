import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type DocumentData,
  type Firestore,
  type QueryConstraint,
} from "firebase/firestore";
import { ref, uploadBytesResumable, type FirebaseStorage } from "firebase/storage";
import {
  UploadCanceledError,
  type Job,
  type RealtimeSource,
  type Sheet,
  type SheetSet,
  type SheetVersion,
  type UploadTransport,
} from "./types";

/* ---------------- Storage: resumable uploads ---------------- */

export function createFirebaseUploads(storage: FirebaseStorage): UploadTransport {
  return {
    start(storagePath, file, contentType, onProgress) {
      // contentType must satisfy storage.rules allowedType(); path comes from the API (never built from the filename).
      const task = uploadBytesResumable(ref(storage, storagePath), file, { contentType });
      const done = new Promise<void>((resolve, reject) => {
        task.on(
          "state_changed",
          (snap) => onProgress(snap.bytesTransferred, snap.totalBytes, snap.state as "running" | "paused"),
          (err) => reject((err as { code?: string }).code === "storage/canceled" ? new UploadCanceledError() : err),
          () => resolve(),
        );
      });
      return { pause: () => task.pause(), resume: () => task.resume(), cancel: () => task.cancel(), done };
    },
  };
}

/* ---------------- Firestore: realtime listeners ---------------- */

/** Firestore Timestamp | ISO string | undefined → ISO string. */
export function toIso(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof (v as { toDate?: unknown }).toDate === "function") return (v as { toDate(): Date }).toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return "";
}

const withId = <T>(id: string, data: DocumentData): T =>
  ({ ...data, id, createdAt: toIso(data.createdAt), ...(data.updatedAt ? { updatedAt: toIso(data.updatedAt) } : {}) }) as T;

const projectPath = (orgId: string, projectId: string) => `orgs/${orgId}/projects/${projectId}`;

export function createFirestoreRealtime(db: Firestore): RealtimeSource {
  return {
    jobs(orgId, projectId, onData, onError) {
      // Rules require the orgId filter on list queries; indexes: (orgId, createdAt desc) and (orgId, projectId, createdAt desc).
      const constraints: QueryConstraint[] = [where("orgId", "==", orgId)];
      if (projectId) constraints.push(where("projectId", "==", projectId));
      constraints.push(orderBy("createdAt", "desc"), limit(50));
      return onSnapshot(
        query(collection(db, "jobs"), ...constraints),
        (snap) => onData(snap.docs.map((d) => withId<Job>(d.id, d.data()))),
        onError,
      );
    },

    sheetSets(orgId, projectId, onData, onError) {
      return onSnapshot(
        query(collection(db, `${projectPath(orgId, projectId)}/sheetSets`), orderBy("createdAt", "desc")),
        (snap) => onData(snap.docs.map((d) => withId<SheetSet>(d.id, d.data()))),
        onError,
      );
    },

    sheets(orgId, projectId, onData, onError) {
      const base = `${projectPath(orgId, projectId)}/sheets`;
      let sheets: Sheet[] = [];
      const versions = new Map<string, SheetVersion | null>(); // key: sheetId/versionId
      const versionSubs = new Map<string, () => void>();
      const emit = () =>
        onData(
          sheets.map((sheet) => ({
            sheet,
            version: sheet.currentVersionId ? (versions.get(`${sheet.id}/${sheet.currentVersionId}`) ?? null) : null,
          })),
        );

      const unsubSheets = onSnapshot(
        collection(db, base),
        (snap) => {
          sheets = snap.docs.map((d) => {
            const data = d.data();
            return {
              ...(data as Omit<Sheet, "id">),
              id: d.id,
              ...(data.updatedAt ? { updatedAt: toIso(data.updatedAt) } : {}),
              ...(data.confirmedAt ? { confirmedAt: toIso(data.confirmedAt) } : {}),
            };
          });
          const wanted = new Set(sheets.filter((s) => s.currentVersionId).map((s) => `${s.id}/${s.currentVersionId}`));
          for (const [key, off] of versionSubs) {
            if (!wanted.has(key)) {
              off();
              versionSubs.delete(key);
              versions.delete(key);
            }
          }
          for (const key of wanted) {
            if (versionSubs.has(key)) continue;
            const [sheetId, versionId] = key.split("/") as [string, string];
            versionSubs.set(
              key,
              onSnapshot(
                doc(db, `${base}/${sheetId}/versions/${versionId}`),
                (d) => {
                  versions.set(key, d.exists() ? { ...withId<SheetVersion>(d.id, d.data()), sheetId } : null);
                  emit();
                },
                onError,
              ),
            );
          }
          emit();
        },
        onError,
      );

      return () => {
        unsubSheets();
        versionSubs.forEach((off) => off());
        versionSubs.clear();
      };
    },
  };
}
