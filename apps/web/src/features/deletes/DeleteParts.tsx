import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useApi } from "@/api/client";
import { ApiError, DEFAULT_PROJECT_QUOTA_BYTES, type Project, type Role } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { formatStorage } from "@/features/boq/sprint7";
import { useReauthGate } from "@/features/auth/reauth";

/** The API's own Hebrew message for an expected refusal (400 / 409), else null. */
const hebrewMessage = (e: unknown): string | null =>
  e instanceof ApiError && (e.status === 400 || e.status === 409) && /[\u0590-\u05FF]/.test(e.message) ? e.message : null;

/** Sheet sets are deleted by editors and admins (like uploads); a whole project only by admins. */
export const canDeleteSets = (role: Role | null | undefined): boolean => role === "admin" || role === "editor";
export const canDeleteProject = (role: Role | null | undefined): boolean => role === "admin";

export interface SetToDelete {
  id: string;
  name: string;
  sheets: number;
  /** Bytes the set holds, when known (shown as "יתפנו כ-…"). */
  bytes?: number | null;
}

export function useDeleteSheetSet(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (setId: string) => api.deleteSheetSet(projectId, setId),
    onSuccess: (r) => {
      // the hub's storage meter updates at once from the answer, then the project refetches
      qc.setQueryData<Project>(["project", projectId], (p) => (p ? { ...p, storageBytes: r.storageBytes, storageQuotaBytes: r.storageQuotaBytes } : p));
      void qc.invalidateQueries({ queryKey: ["project", projectId] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["boq-lines", projectId] });
      void qc.invalidateQueries({ queryKey: ["share-links", projectId] });
    },
  });
}

/**
 * "למחוק את X?" for one sheet set: what goes (sheets, versions, artifacts, corrections), what happens to the BOQ and
 * the share links, the space it frees. The toast after it shows the freed space and the project's storage now.
 */
export function DeleteSetDialog({ projectId, set, onClose }: { projectId: string; set: SetToDelete | null; onClose: () => void }) {
  const { t } = useTranslation();
  const del = useDeleteSheetSet(projectId);
  return (
    <Dialog open={set !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent role="alertdialog" className="max-w-md" aria-describedby="del-set-body" data-delete-set-dialog>
        {set ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {t("deletes.setTitle", { name: "" })}
                <bdi>{set.name}</bdi>
              </DialogTitle>
              <DialogDescription id="del-set-body">{t("deletes.setBody", { count: set.sheets })}</DialogDescription>
            </DialogHeader>
            <p className="text-dense text-foreground">{t("deletes.setBoq")}</p>
            {set.bytes ? <p className="text-meta text-muted-foreground">{t("deletes.setFrees", { size: formatStorage(set.bytes) })}</p> : null}
            <DialogFooter>
              <Button
                variant="destructive"
                disabled={del.isPending}
                onClick={() =>
                  del.mutate(set.id, {
                    onSuccess: (r) => {
                      onClose();
                      const links = r.revokedShareLinks ? ` ${t("deletes.setDoneLinks", { count: r.revokedShareLinks })}` : "";
                      toast({
                        title: `${t("deletes.setDone", { name: set.name, freed: formatStorage(r.releasedBytes), used: formatStorage(r.storageBytes), quota: formatStorage(r.storageQuotaBytes || DEFAULT_PROJECT_QUOTA_BYTES) })}${links}`,
                        tone: "success",
                      });
                    },
                    // 409 conflict while the set is still processing: the API's Hebrew text (contracts SHEET_SET_DELETE_BUSY_HE)
                    onError: (e) => toast({ title: hebrewMessage(e) ?? t("deletes.setError"), tone: "error" }),
                  })
                }
              >
                <Trash2 aria-hidden />
                {del.isPending ? t("deletes.deleting") : t("deletes.setConfirm")}
              </Button>
              <Button variant="secondary" onClick={onClose} autoFocus>
                {t("deletes.keep")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Project settings → "אזור מסוכן" (admin): typed confirmation = the project name + "הבנתי…", behind the recent
 * sign-in gate like other destructive admin actions. Afterwards: back to the projects list with the freed space.
 */
export function DeleteProjectSection({ project, role }: { project: Project; role: Role | null | undefined }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const gate = useReauthGate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [understand, setUnderstand] = useState(false);
  const [touched, setTouched] = useState(false);
  const id = useId();
  useEffect(() => {
    if (open) {
      setTyped("");
      setUnderstand(false);
      setTouched(false);
    }
  }, [open]);
  const del = useMutation({
    mutationFn: () => api.deleteProject(project.id, { confirmName: typed }),
    onSuccess: (r) => {
      setOpen(false);
      qc.removeQueries({ queryKey: ["project", project.id] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      toast({ title: t("deletes.projectDone", { name: project.name, freed: formatStorage(r.releasedBytes) }), tone: "success" });
      navigate("/projects", { replace: true });
    },
    onError: (e) => {
      // 400 = the typed name does not match (contracts PROJECT_DELETE_MISMATCH_HE)
      if (!gate.handle(e, () => del.mutate())) toast({ title: hebrewMessage(e) ?? t("deletes.projectError"), tone: "error" });
    },
  });
  // contracts deleteConfirmationMatches: trimmed, NFC; the server checks again
  const norm = (x: string) => x.normalize("NFC").replace(/\s+/g, " ").trim();
  const match = norm(typed).length > 0 && norm(typed) === norm(project.name);
  const admin = canDeleteProject(role);
  return (
    <section aria-labelledby={`${id}-t`} className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/[0.03] p-5" data-danger-zone>
      <h2 id={`${id}-t`} className="flex items-center gap-2 text-panel font-bold text-destructive">
        <AlertTriangle className="size-4" aria-hidden />
        {t("deletes.projectZone")}
      </h2>
      <p className="text-dense text-foreground">{t("deletes.projectZoneHint")}</p>
      {admin ? (
        <Button variant="destructive" className="self-start" onClick={() => setOpen(true)}>
          <Trash2 aria-hidden />
          {t("deletes.projectDelete")}
        </Button>
      ) : (
        <p className="text-meta text-muted-foreground">{t("deletes.adminOnly")}</p>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent role="alertdialog" className="max-w-md" aria-describedby={`${id}-b`} data-delete-project-dialog>
          {/* outside the <form>: the re-authentication box has its own password form */}
          {gate.element}
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (!match || !understand) return;
              void gate.guard(() => del.mutate());
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("deletes.projectTitle")}</DialogTitle>
              <DialogDescription id={`${id}-b`}>{t("deletes.projectBody", { name: project.name, size: formatStorage(project.storageBytes ?? 0) })}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-n`} className="text-dense font-medium text-foreground">
                {t("deletes.projectType", { name: "" })}
                <bdi className="font-bold">{project.name}</bdi>
              </label>
              <Input
                id={`${id}-n`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                aria-invalid={touched && !match}
                aria-describedby={touched && !match ? `${id}-e` : undefined}
              />
              {touched && !match ? (
                <p id={`${id}-e`} role="alert" className="text-meta text-destructive">
                  {t("deletes.projectMismatch")}
                </p>
              ) : null}
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 text-dense text-foreground">
              <input type="checkbox" checked={understand} onChange={(e) => setUnderstand(e.target.checked)} className="size-4 accent-[rgb(var(--destructive))]" />
              {t("deletes.projectUnderstand")}
            </label>
            <DialogFooter>
              <Button type="submit" variant="destructive" disabled={!match || !understand || del.isPending || gate.pending}>
                <Trash2 aria-hidden />
                {del.isPending ? t("deletes.deleting") : t("deletes.projectConfirm")}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                {t("deletes.keep")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
