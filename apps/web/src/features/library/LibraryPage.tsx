import { useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookMarked, FileSpreadsheet, Pencil, Search, Star, Upload } from "lucide-react";
import type { BoqRule, BoqTemplate, LibraryItem, Role } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { EmptyState } from "@/components/EmptyState";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { compareCodes } from "@/features/boq/model";
import { className } from "@/features/understanding/taxonomy";
import { useLibraryItems, usePatchLibraryItem, usePatchRule, useRules, useSetDefaultTemplate, useTemplates } from "@/features/boq/queries";
import { ImportDialog } from "./ImportDialog";

type Tab = "items" | "templates" | "rules";

/** S03/S04 "ספריית סעיפים": items (search, chapter filter, edit, import past BOQ), templates (read-only + default), rules. */
export function LibraryPage() {
  const { t } = useTranslation();
  const { org } = useCurrentOrg();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "templates" ? "templates" : params.get("tab") === "rules" ? "rules" : "items";
  const setTab = (v: Tab) => {
    const next = new URLSearchParams(params);
    if (v === "items") next.delete("tab");
    else next.set("tab", v);
    setParams(next, { replace: true });
  };
  const orgId = org?.id ?? "";
  const role = org?.role ?? "viewer";
  const tabs: { id: Tab; label: string }[] = [
    { id: "items", label: t("library.tabItems") },
    { id: "templates", label: t("library.tabTemplates") },
    { id: "rules", label: t("library.tabRules") },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-screen text-foreground">
          <BookMarked className="size-5 text-primary" aria-hidden />
          {t("library.title")}
        </h1>
        <p className="text-body text-muted-foreground">{t("library.subtitle")}</p>
      </div>
      <div role="tablist" aria-label={t("library.tabsLabel")} className="flex gap-1 border-b border-border">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`lib-tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`lib-panel-${x.id}`}
            tabIndex={tab === x.id ? 0 : -1}
            onClick={() => setTab(x.id)}
            className={cn(
              "relative px-3 pb-2.5 pt-1 text-body font-medium text-muted-foreground hover:text-foreground",
              tab === x.id && "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
            )}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`lib-panel-${tab}`} aria-labelledby={`lib-tab-${tab}`}>
        {tab === "items" ? <ItemsTab orgId={orgId} role={role} /> : tab === "templates" ? <TemplatesTab orgId={orgId} role={role} /> : <RulesTab orgId={orgId} role={role} />}
      </div>
    </div>
  );
}

/* ---------------- items ---------------- */

function ItemsTab({ orgId, role }: { orgId: string; role: Role }) {
  const { t } = useTranslation();
  const searchId = useId();
  const chapterId = useId();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [chapter, setChapter] = useState("");
  const [editing, setEditing] = useState<LibraryItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(id);
  }, [q]);
  const items = useLibraryItems(orgId, { ...(debounced ? { q: debounced } : {}), ...(chapter ? { chapter } : {}) });
  const templates = useTemplates(orgId);
  const chapters = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of templates.data?.find((x) => x.default)?.chapters ?? []) m.set(c.code, c.title);
    for (const i of items.data?.items ?? []) if (!m.has(i.chapter)) m.set(i.chapter, i.chapterTitle ?? i.chapter);
    return [...m.entries()].sort(([a], [b]) => compareCodes(a, b));
  }, [templates.data, items.data]);
  const rows = useMemo(() => [...(items.data?.items ?? [])].sort((a, b) => compareCodes(a.code, b.code)), [items.data]);
  const canEdit = role === "admin" || role === "editor";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-60 flex-1 flex-col gap-1.5">
          <Label htmlFor={searchId}>{t("library.search")}</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input id={searchId} type="search" value={q} onChange={(e) => setQ(e.target.value)} className="ps-9" />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={chapterId}>{t("library.chapter")}</Label>
          <select
            id={chapterId}
            value={chapter}
            onChange={(e) => setChapter(e.target.value)}
            className="h-10 max-w-72 rounded border border-input bg-surface px-2 text-body text-foreground"
          >
            <option value="">{t("library.allChapters")}</option>
            {chapters.map(([code, title]) => (
              <option key={code} value={code}>
                {title}
              </option>
            ))}
          </select>
        </div>
        {canEdit ? (
          <Button onClick={() => setImportOpen(true)}>
            <Upload aria-hidden />
            {t("library.import")}
          </Button>
        ) : null}
      </div>

      {items.isError ? (
        <p role="alert" className="text-body text-destructive">{t("library.loadError")}</p>
      ) : items.isLoading ? (
        <p role="status" className="text-body text-muted-foreground">{t("common.loading")}</p>
      ) : rows.length === 0 ? (
        debounced || chapter ? (
          <p className="py-8 text-center text-body text-muted-foreground">{t("library.noResults")}</p>
        ) : (
          <EmptyState
            title={t("library.empty")}
            illustration={<FileSpreadsheet className="size-10 text-primary" aria-hidden />}
            action={canEdit ? <Button onClick={() => setImportOpen(true)}>{t("library.import")}</Button> : undefined}
          />
        )
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full border-collapse text-dense">
            <caption className="sr-only">{t("library.title")}</caption>
            <thead>
              <tr className="h-9 border-b border-border bg-surface-sunken text-meta text-muted-foreground">
                <th scope="col" className="w-20 px-3 text-start font-medium">{t("library.columns.code")}</th>
                <th scope="col" className="px-3 text-start font-medium">{t("library.columns.desc")}</th>
                <th scope="col" className="w-20 px-3 text-start font-medium">{t("library.columns.unit")}</th>
                <th scope="col" className="hidden w-56 px-3 text-start font-medium md:table-cell">{t("library.columns.chapter")}</th>
                <th scope="col" className="w-24 px-3 text-start font-medium">{t("library.columns.source")}</th>
                <th scope="col" className="w-16 px-3 text-end font-medium">
                  <span className="sr-only">{t("library.columns.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className={cn("border-b border-border last:border-0 hover:bg-surface-sunken/60", !i.active && "text-muted-foreground")}>
                  <td className="px-3 py-2 font-mono text-meta text-foreground">
                    <Ltr>{i.code}</Ltr>
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn("text-foreground", !i.active && "text-muted-foreground line-through")}>{i.description}</span>
                    {!i.active ? <Badge className="ms-2">{t("library.inactive")}</Badge> : null}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{i.unit}</td>
                  <td className="hidden truncate px-3 py-2 text-muted-foreground md:table-cell">{i.chapterTitle ?? i.chapter}</td>
                  <td className="px-3 py-2">
                    <Badge variant={i.source === "import" ? "neutral" : "primary"}>
                      {i.source === "import" ? t("library.sourceImport") : t("library.sourceManual")}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-end">
                    {canEdit ? (
                      <Button size="icon-sm" variant="ghost" onClick={() => setEditing(i)} aria-label={`${t("library.edit")} ${i.code}`}>
                        <Pencil aria-hidden />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length ? <p className="text-meta text-muted-foreground">{t("library.count", { count: rows.length })}</p> : null}
      <EditItemDialog orgId={orgId} item={editing} onClose={() => setEditing(null)} />
      <ImportDialog orgId={orgId} open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

function EditItemDialog({ orgId, item, onClose }: { orgId: string; item: LibraryItem | null; onClose: () => void }) {
  const { t } = useTranslation();
  const patch = usePatchLibraryItem(orgId);
  const unitId = useId();
  const [unit, setUnit] = useState("");
  const [active, setActive] = useState(true);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!item) return;
    setUnit(item.unit);
    setActive(item.active);
    setTouched(false);
  }, [item]);
  const err = unit.trim().length === 0;
  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined}>
        {item ? (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (err) return;
              patch.mutate(
                { id: item.id, req: { unit: unit.trim(), active } },
                {
                  onSuccess: () => {
                    toast({ title: t("library.saved", { code: item.code }), tone: "success" });
                    onClose();
                  },
                  onError: () => toast({ title: t("library.saveError"), tone: "error" }),
                },
              );
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {t("library.editTitle", { code: "" })}
                <Ltr>{item.code}</Ltr>
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-dense font-medium text-foreground">{t("library.desc")}</span>
                <p className="rounded border border-border bg-surface-sunken px-3 py-2 text-body text-foreground">{item.description}</p>
                <p className="text-meta text-muted-foreground">{t("library.descIdentity")}</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={unitId}>{t("library.unit")}</Label>
                <Input
                  id={unitId}
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  aria-invalid={touched && err}
                  aria-describedby={touched && err ? `${unitId}-err` : undefined}
                  className="w-40"
                />
                {touched && err ? <p id={`${unitId}-err`} className="text-meta text-destructive">{t("library.unitRequired")}</p> : null}
              </div>
              <label className="inline-flex items-center gap-2 text-body text-foreground">
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-4 accent-[rgb(var(--primary))]" />
                {t("library.active")}
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>
                {t("library.cancel")}
              </Button>
              <Button type="submit" disabled={patch.isPending}>
                {t("library.save")}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- templates ---------------- */

function TemplatesTab({ orgId, role }: { orgId: string; role: Role }) {
  const { t } = useTranslation();
  const templates = useTemplates(orgId);
  const setDefault = useSetDefaultTemplate(orgId);
  if (templates.isError) return <p role="alert" className="text-body text-destructive">{t("library.loadError")}</p>;
  if (templates.isLoading) return <p role="status" className="text-body text-muted-foreground">{t("common.loading")}</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-dense text-muted-foreground">{t("library.templateReadOnly")}</p>
      <ul className="grid gap-3 md:grid-cols-2">
        {(templates.data ?? []).map((tp: BoqTemplate) => (
          <li key={tp.id} className={cn("flex flex-col gap-3 rounded-md border bg-surface p-4", tp.default ? "border-primary/50" : "border-border")}>
            <div className="flex items-start gap-2">
              <FileSpreadsheet className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
              <h2 className="flex-1 text-panel text-foreground">{tp.name}</h2>
              {tp.default ? (
                <Badge variant="primary">
                  <Star className="size-3" aria-hidden />
                  {t("library.templateDefault")}
                </Badge>
              ) : null}
            </div>
            <p className="text-meta text-muted-foreground">
              {t("library.templateChapters", { count: tp.chapters.length })} · {t("library.templateColumns")}:{" "}
              {tp.columns.map((c) => (typeof c === "string" ? c : c.title)).join(" | ")}
            </p>
            <ol className="flex flex-col gap-0.5 text-dense text-foreground">
              {tp.chapters.map((c) => (
                <li key={c.code} className="truncate">
                  {c.title}
                  {c.notes.length ? <span className="text-meta text-muted-foreground"> · {t("library.templateNotes", { count: c.notes.length })}</span> : null}
                </li>
              ))}
            </ol>
            {!tp.default && role === "admin" ? (
              <Button
                size="sm"
                variant="secondary"
                className="self-start"
                disabled={setDefault.isPending}
                onClick={() =>
                  setDefault.mutate(tp.id, {
                    onSuccess: () => toast({ title: t("library.defaultSet", { name: tp.name }), tone: "success" }),
                    onError: () => toast({ title: t("library.saveError"), tone: "error" }),
                  })
                }
              >
                <Star aria-hidden />
                {t("library.setDefault")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------- rules ---------------- */

/** Plain-Hebrew condition of a rule (never raw ids — spec principle 8). */
function useMatchText() {
  const { t } = useTranslation();
  return (r: BoqRule): string => {
    if (r.description) return r.description;
    const m = r.match as Record<string, unknown>;
    const classes = (Array.isArray(m.classes) ? (m.classes as string[]) : typeof m.class === "string" ? [m.class] : []).map((c) => className(c));
    switch (r.kind) {
      case "class_to_item":
        return classes.join(", ");
      case "composite_lighting": {
        const parts = [t(`library.groupKinds.${String(m.groupKind ?? "single")}`, { defaultValue: String(m.groupKind ?? "") })];
        if (typeof m.switchCount === "number") parts.push(t("boq.groupSw", { count: m.switchCount }));
        if (typeof m.pointCount === "number") parts.push(t("library.points", { count: m.pointCount }));
        return parts.join(" · ");
      }
      case "install_count": {
        const ex = (Array.isArray(m.excludeClasses) ? (m.excludeClasses as string[]) : []).map((c) => className(c));
        return ex.length ? `${classes.join(", ")} · ${t("library.excluding", { list: ex.join(", ") })}` : classes.join(", ");
      }
      case "authority":
        return `${classes.join(", ")} ← ${t(`disciplines.${String(m.discipline ?? "other")}`, { defaultValue: String(m.discipline ?? "") })}`;
    }
    return r.itemDescription ?? "";
  };
}

function RulesTab({ orgId, role }: { orgId: string; role: Role }) {
  const { t } = useTranslation();
  const rules = useRules(orgId);
  const patch = usePatchRule(orgId);
  const admin = role === "admin";
  const matchText = useMatchText();
  if (rules.isError) return <p role="alert" className="text-body text-destructive">{t("library.loadError")}</p>;
  if (rules.isLoading) return <p role="status" className="text-body text-muted-foreground">{t("common.loading")}</p>;
  return (
    <div className="flex flex-col gap-3">
      {!admin ? <p className="text-dense text-muted-foreground">{t("library.rulesAdminOnly")}</p> : null}
      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table className="w-full border-collapse text-dense">
          <caption className="sr-only">{t("library.rules")}</caption>
          <thead>
            <tr className="h-9 border-b border-border bg-surface-sunken text-meta text-muted-foreground">
              <th scope="col" className="w-40 px-3 text-start font-medium">{t("library.ruleColumns.kind")}</th>
              <th scope="col" className="px-3 text-start font-medium">{t("library.ruleColumns.match")}</th>
              <th scope="col" className="w-20 px-3 text-start font-medium">{t("library.ruleColumns.item")}</th>
              <th scope="col" className="w-20 px-3 text-end font-medium">{t("library.ruleColumns.priority")}</th>
              <th scope="col" className="w-20 px-3 text-center font-medium">{t("library.ruleColumns.enabled")}</th>
            </tr>
          </thead>
          <tbody>
            {(rules.data ?? []).map((r) => {
              const name = matchText(r);
              return (
                <tr key={r.id} className={cn("border-b border-border last:border-0", !r.enabled && "text-muted-foreground")}>
                  <td className="px-3 py-2 text-foreground">{t(`library.ruleKinds.${r.kind}`)}</td>
                  <td className="px-3 py-2">
                    <bdi>{name}</bdi>
                  </td>
                  <td className="px-3 py-2 font-mono text-meta">{r.itemCode ? <Ltr>{r.itemCode}</Ltr> : "—"}</td>
                  <td className="px-3 py-2 text-end tabular">{r.priority}</td>
                  <td className="px-3 py-2 text-center">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={r.enabled}
                      aria-label={t("library.ruleToggle", { name })}
                      disabled={!admin || patch.isPending}
                      onClick={() =>
                        patch.mutate(
                          { id: r.id, enabled: !r.enabled },
                          {
                            onSuccess: () => toast({ title: t("library.ruleToggled") }),
                            onError: () => toast({ title: t("library.saveError"), tone: "error" }),
                          },
                        )
                      }
                      className={cn(
                        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                        r.enabled ? "bg-primary" : "bg-muted-foreground/40",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "block size-4 rounded-full bg-surface shadow transition-transform",
                          r.enabled ? "ltr:translate-x-4 rtl:-translate-x-4" : "translate-x-0",
                        )}
                      />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
