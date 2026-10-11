import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { useApi } from "@/api/client";
import { useUploadStore } from "@/features/upload/uploadStore";
import { useCreateProject } from "./queries";

export function CreateProjectDialog({
  open,
  onOpenChange,
  pendingFiles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Files dropped on the empty state — uploaded right after the project is created. */
  pendingFiles?: File[];
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const api = useApi();
  const create = useCreateProject();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setAddress("");
    setError(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("createProject.errorName"));
      return;
    }
    let project;
    try {
      project = await create.mutateAsync({ name: name.trim(), address: address.trim() || null });
    } catch {
      setError(t("createProject.errorGeneric"));
      return;
    }
    toast({ title: t("createProject.created", { name: project.name }), tone: "success" });
    if (pendingFiles?.length) void useUploadStore.getState().addFiles(api, project.id, pendingFiles);
    onOpenChange(false);
    reset();
    navigate(`/projects/${project.id}`);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createProject.title")}</DialogTitle>
          <DialogDescription>{t("createProject.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Field id="project-name" label={t("createProject.name")} error={error}>
            <Input
              id="project-name"
              value={name}
              placeholder={t("createProject.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "project-name-error" : undefined}
              autoFocus
              required
            />
          </Field>
          <Field id="project-address" label={t("createProject.address")}>
            <Input
              id="project-address"
              value={address}
              placeholder={t("createProject.addressPlaceholder")}
              onChange={(e) => setAddress(e.target.value)}
              autoComplete="street-address"
            />
          </Field>
          <Field id="project-template" label={t("createProject.template")}>
            <select
              id="project-template"
              className="h-10 rounded border border-input bg-surface px-3 text-body text-foreground"
              defaultValue="default"
            >
              <option value="default">{t("createProject.templateDefault")}</option>
            </select>
          </Field>
          {pendingFiles?.length ? <PendingNote count={pendingFiles.length} /> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t("createProject.cancel")}</Button>
            </DialogClose>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t("createProject.submitting") : t("createProject.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PendingNote({ count }: { count: number }): ReactNode {
  const { t } = useTranslation();
  return (
    <p className="rounded border border-border bg-surface-sunken px-3 py-2 text-dense text-muted-foreground">
      {t("createProject.pendingFiles", { count })}
    </p>
  );
}
