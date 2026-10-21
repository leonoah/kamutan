import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Clock, Download, Eye, Link2Off, SearchX } from "lucide-react";
import { useBackend } from "@/api/client";
import { shareErrorKind } from "@/api/http";
import type { PublicBoqLine, PublicShareMeta, ShareErrorKind } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ConfidenceBadge, levelFromDb } from "@/components/ConfidenceBadge";
import { Logo } from "@/components/Logo";
import { Ltr } from "@/components/Ltr";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { compareCodes, fmtQty } from "@/features/boq/model";
import { useShareBoq, useShareMeta, useShareOverlay } from "./queries";

const SharedDrawing = lazy(() => import("./SharedDrawing"));

/** `<meta name=…>` for the lifetime of the page (crawlers + referrer; the server sends the same as headers). */
function useMeta(name: string, content: string) {
  useEffect(() => {
    let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
    const created = !el;
    const prev = el?.content ?? null;
    if (!el) {
      el = document.createElement("meta");
      el.name = name;
      document.head.appendChild(el);
    }
    el.content = content;
    return () => {
      if (created) el!.remove();
      else if (prev !== null) el!.content = prev;
    };
  }, [name, content]);
}

/**
 * S15 external viewer `/s/:token` (FR-30, E2E-09): no account, no auth, read-only. BOQ + drawing with evidence
 * highlight both ways, watermark, Hebrew RTL, and clear screens for an expired / revoked / unknown link. The page only
 * talks to the GET-only public client; it has no edit control and no way to call the member API.
 */
export function SharedViewerPage() {
  const { token = "" } = useParams();
  const { t } = useTranslation();
  useMeta("robots", "noindex,nofollow");
  useMeta("referrer", "no-referrer");
  const meta = useShareMeta(token);
  const boq = useShareBoq(token, meta.isSuccess);

  useEffect(() => {
    const prev = document.title;
    document.title = meta.data ? `${meta.data.projectName} · ${t("shareViewer.readOnly")}` : t("app.name");
    return () => void (document.title = prev);
  }, [meta.data, t]);

  if (meta.isLoading) {
    return (
      <div role="status" className="flex min-h-dvh items-center justify-center bg-background text-muted-foreground">
        {t("shareViewer.loading")}
      </div>
    );
  }
  if (meta.isError || !meta.data) return <ShareGone kind={shareErrorKind(meta.error)} />;
  const boqErr = boq.isError ? shareErrorKind(boq.error) : null;
  if (boqErr && boqErr !== "error") return <ShareGone kind={boqErr} />;
  return <SharedViewer token={token} meta={meta.data} lines={boq.data?.lines ?? null} chapters={boq.data?.chapters ?? []} boqError={boq.isError} />;
}

export function ShareGone({ kind }: { kind: ShareErrorKind }) {
  const { t } = useTranslation();
  const conf = {
    expired: { Icon: Clock, title: t("shareViewer.expiredTitle"), body: t("shareViewer.inactiveBody") },
    revoked: { Icon: Link2Off, title: t("shareViewer.revokedTitle"), body: t("shareViewer.inactiveBody") },
    not_found: { Icon: SearchX, title: t("shareViewer.notFoundTitle"), body: t("shareViewer.notFoundBody") },
    rate_limited: { Icon: Clock, title: t("shareViewer.rateTitle"), body: t("shareViewer.rateBody") },
    error: { Icon: SearchX, title: t("shareViewer.errorTitle"), body: t("shareViewer.errorBody") },
  }[kind];
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center" data-share-state={kind}>
      <Logo />
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-surface p-8 shadow-sm">
        <conf.Icon className="size-8 text-muted-foreground" aria-hidden />
        <h1 className="text-screen font-bold text-foreground">{conf.title}</h1>
        <p className="text-body text-muted-foreground">{conf.body}</p>
      </div>
    </main>
  );
}

function SharedViewer({ token, meta, lines, chapters, boqError }: { token: string; meta: PublicShareMeta; lines: PublicBoqLine[] | null; chapters: { code: string; title: string }[]; boqError: boolean }) {
  const { t } = useTranslation();
  const { publicShare } = useBackend();
  const qc = useQueryClient();
  const [sheetId, setSheetId] = useState<string | null>(meta.sheets[0]?.id ?? null);
  const [jumped, setJumped] = useState<string | null>(null);
  const [lineId, setLineId] = useState<string | null>(null);
  const sheet = meta.sheets.find((s) => s.id === sheetId) ?? null;
  const overlay = useShareOverlay(token, sheet?.id ?? null);
  const evidence = overlay.data?.evidence;
  const evidenceIndex = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [l, dets] of Object.entries(evidence ?? {})) for (const d of dets) m.set(d, [...(m.get(d) ?? []), l]);
    return m;
  }, [evidence]);
  const focusIds = useMemo(() => (lineId ? (evidence?.[lineId] ?? []) : []), [lineId, evidence]);
  const pdfHref = useMemo(() => (meta.allowPdfDownload ? publicShare.pdfUrl(token) : null), [meta.allowPdfDownload, publicShare, token]);

  const groups = useMemo(() => {
    const by = new Map<string, PublicBoqLine[]>();
    for (const l of lines ?? []) by.set(l.chapter, [...(by.get(l.chapter) ?? []), l]);
    return [...by.entries()]
      .sort(([a], [b]) => compareCodes(a, b))
      .map(([code, ls]) => ({
        code,
        title: chapters.find((c) => c.code === code)?.title ?? ls[0]?.chapterTitle ?? code,
        lines: ls.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || compareCodes(a.code, b.code)),
      }));
  }, [lines, chapters]);

  /**
   * Row → drawing: select the line; when it has no item on the current sheet, look for the first sheet that has
   * (overlays fetched on demand, cached) and switch to it — like the review workspace's sheet jump.
   */
  const selectLine = async (id: string) => {
    if (lineId === id) {
      setLineId(null);
      return;
    }
    setLineId(id);
    setJumped(null);
    if ((evidence?.[id] ?? []).length > 0) return;
    const order = [...meta.sheets].sort((a, b) => Number(b.id === sheetId) - Number(a.id === sheetId));
    for (const s of order) {
      try {
        const o = await qc.fetchQuery({ queryKey: ["share", token, "overlay", s.id], queryFn: () => publicShare.getOverlay(token, s.id), staleTime: 5 * 60_000 });
        if ((o.evidence[id] ?? []).length > 0) {
          if (s.id !== sheetId) {
            setSheetId(s.id);
            setJumped(s.title ?? s.id);
          }
          return;
        }
      } catch {
        return;
      }
    }
  };
  const selected = lines?.find((l) => l.id === lineId) ?? null;

  return (
    <div className="flex min-h-dvh flex-col bg-background lg:h-dvh lg:overflow-hidden" data-share-viewer>
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-2.5">
        <Logo withText={false} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-panel font-bold text-foreground">
            {meta.orgName ? `${meta.orgName} · ` : ""}
            {meta.projectName}
          </h1>
          <p className="flex flex-wrap gap-x-2 text-meta text-muted-foreground">
            {meta.label ? <span>{meta.label}</span> : null}
            {meta.versionDate ? (
              <span>
                · {t("shareViewer.versionFrom", { date: "" })}
                <Ltr>{formatDate(meta.versionDate)}</Ltr>
              </span>
            ) : null}
            <span>
              · {t("shareViewer.validUntil", { date: "" })}
              <Ltr>{formatDate(meta.expiresAt)}</Ltr>
            </span>
          </p>
        </div>
        <span className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-primary/40 bg-primary/[0.06] px-2 text-dense font-medium text-foreground" data-read-only>
          <Eye className="size-4" aria-hidden />
          {t("shareViewer.readOnly")}
        </span>
        {pdfHref ? (
          <Button size="sm" variant="secondary" asChild>
            <a href={pdfHref} download="kamutan-marked.pdf" rel="noopener noreferrer" referrerPolicy="no-referrer">
              <Download aria-hidden />
              {t("shareViewer.downloadPdf")}
            </a>
          </Button>
        ) : null}
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(22rem,38%)_1fr]">
        <section aria-label={t("shareViewer.boq")} className="flex min-h-0 flex-col border-b border-border bg-surface lg:border-b-0 lg:border-e">
          <h2 className="shrink-0 border-b border-border px-4 py-2 text-panel font-bold text-foreground">{t("shareViewer.boq")}</h2>
          <div className="min-h-0 flex-1 overflow-auto">
            {boqError ? (
              <p role="alert" className="p-4 text-dense text-destructive">{t("shareViewer.errorBody")}</p>
            ) : lines === null ? (
              <p role="status" className="p-4 text-dense text-muted-foreground">{t("common.loading")}</p>
            ) : lines.length === 0 ? (
              <p className="p-4 text-dense text-muted-foreground">{t("shareViewer.noLines")}</p>
            ) : (
              <table className="w-full table-fixed border-separate border-spacing-0 text-dense" data-share-boq>
                <caption className="sr-only">{t("shareViewer.boq")}</caption>
                <colgroup>
                  {meta.showConfidence ? <col className="w-8" /> : null}
                  <col className="w-14" />
                  <col />
                  <col className="w-14" />
                  <col className="w-16" />
                </colgroup>
                <thead>
                  <tr className="text-meta text-muted-foreground">
                    {meta.showConfidence ? (
                      <th scope="col" className="sticky top-0 z-10 h-8 border-b border-border bg-surface ps-3">
                        <span className="sr-only">{t("boq.columns.conf")}</span>
                      </th>
                    ) : null}
                    <th scope="col" className="sticky top-0 z-10 h-8 border-b border-border bg-surface px-1 text-start font-medium first:ps-3">{t("boq.columns.code")}</th>
                    <th scope="col" className="sticky top-0 z-10 h-8 border-b border-border bg-surface px-1 text-start font-medium">{t("boq.columns.desc")}</th>
                    <th scope="col" className="sticky top-0 z-10 h-8 border-b border-border bg-surface px-1 text-start font-medium">{t("boq.columns.unit")}</th>
                    <th scope="col" className="sticky top-0 z-10 h-8 border-b border-border bg-surface pe-3 ps-1 text-end font-medium">{t("boq.columns.qty")}</th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.code}>
                    <tr>
                      <th scope="colgroup" colSpan={meta.showConfidence ? 5 : 4} className="sticky top-8 border-b border-border bg-surface-sunken px-3 py-1.5 text-start font-bold text-foreground">
                        {g.title}
                      </th>
                    </tr>
                    {g.lines.map((l) => {
                      const on = l.id === lineId;
                      const floors = Object.entries(l.byFloor).filter(([, n]) => n);
                      return (
                        <tr key={l.id} data-line={l.id} className={cn("cursor-pointer hover:bg-surface-sunken/70", on && "bg-highlight/60 outline outline-1 -outline-offset-1 outline-primary")} onClick={() => void selectLine(l.id)}>
                          {meta.showConfidence ? (
                            <td className="border-b border-border py-1.5 ps-2 align-top">{l.level ? <ConfidenceBadge level={levelFromDb(l.level)} variant="indicator" /> : null}</td>
                          ) : null}
                          <td className="border-b border-border px-1 pt-2 align-top font-mono text-meta text-foreground first:ps-3">
                            <Ltr>{l.code}</Ltr>
                          </td>
                          <td className="border-b border-border px-1 py-1.5 align-top">
                            <button
                              type="button"
                              aria-pressed={on}
                              aria-label={t("shareViewer.selectLine", { code: l.code })}
                              onClick={(e) => {
                                e.stopPropagation();
                                void selectLine(l.id);
                              }}
                              className="block w-full rounded-sm text-start text-foreground"
                            >
                              <span className="line-clamp-2">{l.description}</span>
                            </button>
                            {on && floors.length > 1 ? (
                              <span className="mt-1 block text-meta text-muted-foreground">
                                {floors.map(([f, n]) => `${t(`floors.${f}`, { defaultValue: f })} ${fmtQty(n)}`).join(" · ")}
                              </span>
                            ) : null}
                          </td>
                          <td className="border-b border-border px-1 pt-2 align-top text-meta text-muted-foreground">{l.unit}</td>
                          <td className="border-b border-border pe-3 ps-1 pt-1.5 text-end align-top font-bold tabular text-foreground">{fmtQty(l.qty)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            )}
          </div>
        </section>

        <section aria-label={t("shareViewer.drawing")} className="flex min-h-[70vh] flex-col lg:min-h-0">
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2 text-dense">
            <label className="inline-flex items-center gap-2 text-muted-foreground">
              {t("shareViewer.sheet")}
              <select
                value={sheetId ?? ""}
                onChange={(e) => {
                  setSheetId(e.target.value);
                  setJumped(null);
                }}
                className="h-8 max-w-64 rounded border border-input bg-surface px-2 text-foreground"
              >
                {meta.sheets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title ?? s.id}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-meta text-muted-foreground" aria-live="polite">
              {selected ? (
                <>
                  <Ltr>{selected.code}</Ltr> ·{" "}
                  {focusIds.length ? t("shareViewer.itemsOnSheet", { count: focusIds.length }) : overlay.isFetching ? "" : t("shareViewer.noEvidenceHere")}
                  {jumped && focusIds.length ? ` · ${t("shareViewer.jumped", { sheet: jumped })}` : null}
                </>
              ) : null}
            </span>
          </div>
          <div className="relative min-h-0 flex-1 bg-canvas">
            {sheet ? (
              <Suspense fallback={<div role="status" className="p-4 text-dense text-muted-foreground">{t("sheets.viewerLoading")}</div>}>
                <SharedDrawing
                  token={token}
                  sheet={sheet}
                  overlay={overlay.data}
                  focusIds={focusIds}
                  showConfidence={meta.showConfidence}
                  watermark={meta.watermark}
                  onPickLine={(id) => setLineId(id)}
                  evidenceIndex={evidenceIndex}
                />
              </Suspense>
            ) : (
              <p className="p-4 text-dense text-muted-foreground">{t("shareViewer.noSheets")}</p>
            )}
          </div>
        </section>
      </div>
      <footer className="shrink-0 border-t border-border bg-surface px-4 py-1.5 text-meta text-muted-foreground">{t("shareViewer.footer")}</footer>
    </div>
  );
}
