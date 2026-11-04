import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, RotateCcw } from "lucide-react";
import { ApiError, DESCRIPTION_MAX, type BoqLine } from "@/api/types";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useReauthGate } from "@/features/auth/reauth";
import { cn } from "@/lib/utils";
import { useRenameLine } from "./queries";
import { checkRename, isDescriptionOverridden, lineDescription } from "./sprint7";
import { ManualNameMarker } from "./ManualNameMarker";

export { ManualNameMarker };

/**
 * Sprint 7 (owner request "לעדכן שם של שורה"): a line's description, renameable in place by editors+.
 *  - view: the wording (override ?? original) + "✎ ידני" when renamed, and a ✎ button (hover / focus; always on touch);
 *    double-click on the text or Enter on the text button opens the editor.
 *  - edit: the text in place (≤ 500, counter), and under it the edit popover: optional reason, "עדכן גם בספריית הסעיפים"
 *    (re-authentication when the API asks for it), "שחזר לנוסח המקורי", save / cancel. Enter saves, Esc cancels.
 * One PATCH `{description, reason?, alsoUpdateLibrary?}` (null = restore), optimistic, one toast with undo.
 */
export function LineDescription({
  projectId,
  line: l,
  canEdit,
  variant,
  onSelect,
  selected,
  selectLabel,
  textClassName,
  extra,
}: {
  projectId: string;
  line: BoqLine;
  canEdit: boolean;
  variant: "panel" | "hub";
  /** Panel: the text is the row's select button. */
  onSelect?: () => void;
  selected?: boolean;
  selectLabel?: string;
  textClassName?: string;
  /** Rendered after the marker (the panel's badges row). */
  extra?: ReactNode;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const shown = lineDescription(l);
  const renamed = isDescriptionOverridden(l);
  const editBtn = useRef<HTMLButtonElement>(null);
  const textBtn = useRef<HTMLButtonElement>(null);
  const close = (focus: boolean) => {
    setEditing(false);
    if (focus) requestAnimationFrame(() => (textBtn.current ?? editBtn.current)?.focus());
  };
  const start = () => {
    if (canEdit) setEditing(true);
  };

  if (editing) return <RenameEditor projectId={projectId} line={l} onClose={close} />;

  const text = <span className={cn("line-clamp-2 break-words text-foreground", textClassName)}>{shown}</span>;
  const pencil = canEdit ? (
    <button
      ref={editBtn}
      type="button"
      data-rename-for={l.id}
      aria-label={t("boq.rename.editFor", { code: l.code })}
      title={t("boq.rename.edit")}
      onClick={(e) => {
        e.stopPropagation();
        start();
      }}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/line:opacity-100 [@media(hover:none)]:opacity-100",
        selected ? "opacity-100" : "opacity-0",
      )}
    >
      <Pencil className="size-3" aria-hidden />
    </button>
  ) : null;

  return (
    <div className="min-w-0" data-description-for={l.id}>
      {variant === "panel" ? (
        <button
          ref={textBtn}
          type="button"
          aria-pressed={selected}
          aria-label={selectLabel}
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.();
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            start();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canEdit) {
              e.preventDefault();
              e.stopPropagation();
              start();
            }
          }}
          className="block w-full rounded-sm text-start"
        >
          {text}
        </button>
      ) : (
        <span className="flex min-w-0 items-start gap-1">
          <span onDoubleClick={start} className="block min-w-0 flex-1">
            {text}
          </span>
          {pencil}
        </span>
      )}
      {renamed || (variant === "panel" && (pencil || extra)) || extra ? (
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
          {renamed ? <ManualNameMarker original={l.description} /> : null}
          {extra}
          {variant === "panel" ? pencil : null}
        </span>
      ) : null}
    </div>
  );
}

function RenameEditor({ projectId, line: l, onClose }: { projectId: string; line: BoqLine; onClose: (focus: boolean) => void }) {
  const { t } = useTranslation();
  const rename = useRenameLine(projectId);
  const gate = useReauthGate();
  const [value, setValue] = useState(lineDescription(l));
  const [reason, setReason] = useState("");
  const [library, setLibrary] = useState(false);
  const [error, setError] = useState<"empty" | "too_long" | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const counterId = useId();
  const errorId = useId();
  const reasonId = useId();
  const libId = useId();
  const optionsId = useId();
  const renamed = isDescriptionOverridden(l);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    // caret at the end: most renames tweak the wording rather than replace it
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const send = (description: string | null, why: string | null, alsoUpdateLibrary: boolean) => {
    const prev = l.descriptionOverride ?? null;
    const prevReason = l.descriptionOverrideReason ?? null;
    rename.mutate(
      { lineId: l.id, description, reason: why, alsoUpdateLibrary },
      {
        onSuccess: () => {
          onClose(true);
          toast({
            title:
              description === null
                ? t("boq.rename.restored", { code: l.code })
                : alsoUpdateLibrary
                  ? t("boq.rename.savedLibrary", { code: l.code })
                  : t("boq.rename.saved", { code: l.code }),
            tone: "success",
            action: {
              label: t("boq.rename.undo"),
              onClick: () =>
                rename.mutate(
                  {
                    lineId: l.id,
                    description: prev,
                    reason: prevReason,
                    alsoUpdateLibrary: false,
                  },
                  {
                    onSuccess: () => toast({ title: t("boq.rename.undone") }),
                    onError: () => toast({ title: t("boq.rename.error"), tone: "error" }),
                  },
                ),
            },
          });
        },
        onError: (e) => {
          if (gate.handle(e, () => send(description, why, alsoUpdateLibrary))) return;
          toast({
            title: e instanceof ApiError && e.status === 403 ? t("boq.rename.forbidden") : t("boq.rename.error"),
            tone: "error",
          });
        },
      },
    );
  };

  const save = () => {
    const c = checkRename(l, value);
    if (!c.ok) {
      if (c.error === "unchanged") {
        // nothing to rename; "also in the library" with the same wording still pushes it to the library
        if (library) send(l.descriptionOverride ?? null, reason.trim() || null, true);
        else onClose(true);
        return;
      }
      setError(c.error);
      areaRef.current?.focus();
      return;
    }
    send(c.description, reason.trim() || null, library);
  };

  const onKey = (e: KeyboardEvent) => {
    // keep the workspace shortcuts (A / R / N / Esc…) out of the editor
    e.stopPropagation();
    // the re-authentication box (password form) handles its own Enter
    if ((e.target as HTMLElement).closest?.("[data-reauth]")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose(true);
    } else if (e.key === "Enter" && !e.shiftKey && (e.target as HTMLElement).tagName !== "BUTTON" && (e.target as HTMLInputElement).type !== "checkbox") {
      e.preventDefault();
      save();
    }
  };

  const n = value.length;
  const near = n > DESCRIPTION_MAX - 50;
  // md+: the editor is one card over the row (anchored at the cell's start, 20rem wide) so the narrow description
  // column stays readable; the hidden copy of the text keeps the row's height. Phones: in the flow.
  return (
    <div className="relative min-w-0">
      <span aria-hidden className="invisible line-clamp-2 max-md:hidden">
        {lineDescription(l)}
      </span>
      <div
        data-rename-editor={l.id}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface p-2 text-start shadow-float md:absolute md:-top-1.5 md:start-[-0.375rem] md:z-30 md:w-80"
      >
        <label htmlFor={fieldId} className="sr-only">
          {t("boq.rename.field", { code: l.code })}
        </label>
        <textarea
          ref={areaRef}
          id={fieldId}
          value={value}
          rows={2}
          maxLength={DESCRIPTION_MAX}
          aria-describedby={`${counterId}${error ? ` ${errorId}` : ""}`}
          aria-invalid={error ? true : undefined}
          aria-controls={optionsId}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          disabled={rename.isPending}
          className={cn(
            "min-h-[3.25rem] w-full resize-y rounded-sm border bg-surface px-1.5 py-1 text-dense leading-snug text-foreground outline-none focus-visible:outline-2 focus-visible:outline-primary",
            error ? "border-destructive" : "border-primary/60",
          )}
        />
        <div className="flex items-center justify-between gap-2 text-[11px] leading-tight">
          <span className="text-muted-foreground">{t("boq.rename.hint")}</span>
          <span id={counterId} data-rename-counter aria-live="polite" className={cn("tabular", near ? "font-medium text-conf-low" : "text-muted-foreground")}>
            <span aria-hidden>{t("boq.rename.counter", { n, max: DESCRIPTION_MAX })}</span>
            <span className="sr-only">{t("boq.rename.counterLabel", { n, max: DESCRIPTION_MAX })}</span>
          </span>
        </div>
        {error ? (
          <p id={errorId} role="alert" className="text-meta text-destructive">
            {error === "empty" ? t("boq.rename.errorEmpty") : t("boq.rename.errorTooLong", { max: DESCRIPTION_MAX })}
          </p>
        ) : null}
        {/* The edit popover: kept in the flow under the field (no portal), so Tab moves field → options → buttons. */}
        <div id={optionsId} role="group" aria-label={t("boq.rename.options")} data-rename-popover className="flex flex-col gap-2 border-t border-border pt-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={reasonId} className="text-meta text-muted-foreground">
              {t("boq.rename.reason")}
            </label>
            <input
              id={reasonId}
              value={reason}
              maxLength={300}
              placeholder={t("boq.rename.reasonPlaceholder")}
              onChange={(e) => setReason(e.target.value)}
              disabled={rename.isPending}
              className="h-7 w-full rounded-sm border border-input bg-surface px-1.5 text-dense text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <label htmlFor={libId} className="inline-flex cursor-pointer items-start gap-1.5 text-dense text-foreground">
              <input
                id={libId}
                type="checkbox"
                checked={library}
                onChange={(e) => setLibrary(e.target.checked)}
                disabled={rename.isPending}
                aria-describedby={`${libId}-hint`}
                className="mt-0.5 size-3.5 shrink-0 accent-[rgb(var(--primary))]"
              />
              {t("boq.rename.library")}
            </label>
            <p id={`${libId}-hint`} className="ps-5 text-[11px] leading-tight text-muted-foreground">
              {t("boq.rename.libraryHint", { code: l.code })}
            </p>
          </div>
          {gate.element}
          {renamed ? (
            <p className="text-[11px] leading-tight text-muted-foreground" data-original>
              {t("boq.rename.original", { text: l.description })}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={save} disabled={rename.isPending || gate.pending}>
              {t("boq.rename.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onClose(true)} disabled={rename.isPending}>
              {t("boq.rename.cancel")}
            </Button>
            {renamed ? (
              <Button
                size="sm"
                variant="secondary"
                className="ms-auto"
                onClick={() => send(null, reason.trim() || null, library)}
                disabled={rename.isPending || gate.pending}
              >
                <RotateCcw aria-hidden />
                {t("boq.rename.restore")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
