import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Archive, ArchiveRestore } from "lucide-react";
import type { Project } from "@/api/types";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { useUpdateProject } from "./queries";

/** Edit name/address of a project, or move it to / restore it from the archive (PATCH /projects/:id). */
export function EditProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateProject();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form whenever the dialog opens for a (possibly different) project.
  useEffect(() => {
    if (open && project) {
      setName(project.name);
      setAddress(project.address ?? "");
      setError(null);
    }
  }, [open, project]);

  const archived = project?.status === "archived";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!project) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("editProject.errorName"));
      return;
    }
    try {
      const saved = await update.mutateAsync({ id: project.id, patch: { name: trimmed, address: address.trim() } });
      toast({ title: t("editProject.saved", { name: saved.name }), tone: "success" });
      onOpenChange(false);
    } catch {
      setError(t("editProject.errorGeneric"));
    }
  }

  async function toggleArchive() {
    if (!project) return;
    try {
      const saved = await update.mutateAsync({ id: project.id, patch: { status: archived ? "active" : "archived" } });
      toast({ title: t(archived ? "editProject.restored" : "editProject.archived", { name: saved.name }), tone: "success" });
      onOpenChange(false);
    } catch {
      setError(t("editProject.errorGeneric"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editProject.title")}</DialogTitle>
          <DialogDescription>{t("editProject.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Field id="edit-project-name" label={t("editProject.name")} error={error}>
            <Input
              id="edit-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "edit-project-name-error" : undefined}
              autoFocus
              required
            />
          </Field>
          <Field id="edit-project-address" label={t("editProject.address")}>
            <Input
              id="edit-project-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              autoComplete="street-address"
            />
          </Field>

          <div className="flex flex-col gap-2 rounded border border-border bg-surface-sunken p-3">
            <p className="text-meta text-muted-foreground">{t("editProject.archiveHint")}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={archived ? "self-start" : "self-start text-destructive hover:bg-destructive/[0.06]"}
              disabled={update.isPending || !project}
              onClick={() => void toggleArchive()}
            >
              {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
              {t(archived ? "editProject.restore" : "editProject.archive")}
            </Button>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t("editProject.cancel")}</Button>
            </DialogClose>
            <Button type="submit" disabled={update.isPending || !project}>
              {update.isPending ? t("editProject.saving") : t("editProject.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
