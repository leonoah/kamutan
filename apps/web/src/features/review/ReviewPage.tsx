import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookOpenCheck, ChevronLeft, ChevronRight, Download, Search, Share2 } from "lucide-react";
import type { LassoResult } from "@kamutan/viewer";
import type { Detection, SheetRow, UnknownCluster } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { Logo } from "@/components/Logo";
import { UserMenu } from "@/components/AppShell";
import { ConfidenceShape } from "@/components/ConfidenceBadge";
import { Kbd } from "@/components/Kbd";
import { Ltr } from "@/components/Ltr";
import { useProject } from "@/features/projects/queries";
import { useLiveSheets } from "@/features/realtime/hooks";
import { sheetName } from "@/features/sheets/model";
import {
  DEFAULT_LIFECYCLES,
  EMPTY_FILTERS,
  LEVEL_KEYS,
  applyFilters,
  boundsOf,
  countsByClass,
  detectionMarkers,
  filtersFromParams,
  filtersToParams,
  isFiltered,
  legendBoxes,
  levelKeyOf,
  overlayFeatures,
  reviewQueue,
  roomPolygons,
  roomsById,
  verifiedPct,
  type LevelKey,
  type LifecycleVisibility,
  type OverlayFilters,
} from "@/features/understanding/model";
import { useOverlay, useResolveCluster } from "@/features/understanding/queries";
import { className, domainOf } from "@/features/understanding/taxonomy";
import { CountsPanel } from "./CountsPanel";
import { DetectionDetails, type DetectionContext } from "./DetectionDetails";
import { FilterBar, type FilterOption } from "./FilterBar";
import { QueuePanel } from "./QueuePanel";
import { ReviewDrawing, parseBBox, type LayerVisibility } from "./ReviewDrawing";

/** Picker order: sheets with detections first, then electrical, lighting, the rest (by name). */
const rank = (r: SheetRow) =>
  (r.version?.artifacts?.detections ? 0 : 10) + (r.sheet.discipline === "electrical" ? 0 : r.sheet.discipline === "lighting" ? 1 : 2);

/**
 * S10 "סביבת הבדיקה" — Sprint 2: the drawing shows the worker's understanding of the current sheet
 * (detections ●▲◆◇, rooms, legend), the right pane counts by class (the BOQ table lands in Sprint 3) and the
 * left pane asks "מה זה?" once per unknown cluster, then lists the items to review.
 * Panel order in RTL reading order: counts (right) · drawing (center, LTR) · queue (left).
 */
export function ReviewPage() {
  const { projectId = "" } = useParams();
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const project = useProject(projectId);
  const name = project.data?.name ?? "…";
  const notYet = () => toast({ title: t("review.placeholderNote") });

  /* ---------- sheet ---------- */
  const sheets = useLiveSheets(project.data?.orgId ?? null, projectId);
  const ready = useMemo(
    () =>
      (sheets.data ?? [])
        .filter((r) => r.version?.status === "ready")
        .sort((a, b) => rank(a) - rank(b) || sheetName(a).localeCompare(sheetName(b), "he")),
    [sheets.data],
  );
  const wanted = params.get("sheet");
  const row = ready.find((r) => r.sheet.id === wanted) ?? ready[0] ?? null;
  const bbox = row && row.sheet.id === wanted ? parseBBox(params.get("bbox")) : null;

  /* ---------- overlay + view state ---------- */
  const overlay = useOverlay(projectId, row);
  const resolve = useResolveCluster(projectId);
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const setFilters = (f: OverlayFilters) => setParams(filtersToParams(f, params), { replace: true });
  const [lifecycles, setLifecycles] = useState<LifecycleVisibility>(DEFAULT_LIFECYCLES);
  const [layers, setLayers] = useState<LayerVisibility>({ symbols: true, rooms: true, legend: true });
  const [selectedClass, setSelectedClass] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lassoIds, setLassoIds] = useState<string[]>([]);
  const [zoomRequest, setZoomRequest] = useState<{ bboxMm: [number, number, number, number]; seq: number } | null>(null);
  const zoomTo = useCallback((b: [number, number, number, number] | null) => b && setZoomRequest((z) => ({ bboxMm: b, seq: (z?.seq ?? 0) + 1 })), []);

  // New sheet → clear the selection.
  const sheetKey = row ? `${row.sheet.id}/${row.version?.id}` : "";
  useEffect(() => {
    setSelectedClass(null);
    setSelectedId(null);
    setLassoIds([]);
    setZoomRequest(null);
  }, [sheetKey]);

  const data = overlay.data;
  const dets = useMemo(() => data?.detections?.detections ?? [], [data]);
  const rooms = useMemo(() => roomsById(data?.rooms ?? null), [data]);
  const legendEntries = useMemo(() => new Map((data?.legend?.entries ?? []).map((e) => [e.id, e])), [data]);
  const thumbs = data?.manifest.thumbs ?? {};
  const filtered = useMemo(() => applyFilters(dets, filters), [dets, filters]);
  const counts = useMemo(() => countsByClass(filtered), [filtered]);
  const byId = useMemo(() => new Map(dets.map((d) => [d.id, d])), [dets]);
  const levelCounts = useMemo(() => {
    const base = applyFilters(dets, { ...filters, levels: [...LEVEL_KEYS] });
    const c: Record<LevelKey, number> = { green: 0, yellow: 0, red: 0, unknown: 0 };
    for (const d of base) c[levelKeyOf(d)]++;
    return c;
  }, [dets, filters]);
  const classItems = useMemo(() => (selectedClass ? filtered.filter((d) => d.class === selectedClass) : []), [filtered, selectedClass]);
  const focusIds = useMemo(() => classItems.map((d) => d.id), [classItems]);
  const clusters = useMemo(() => data?.detections?.unknownClusters ?? [], [data]);
  const clusterMembers = useMemo(() => {
    const m = new Map<string, Detection[]>();
    for (const d of dets) if (d.clusterId) m.set(d.clusterId, [...(m.get(d.clusterId) ?? []), d]);
    return m;
  }, [dets]);
  const queue = useMemo(() => reviewQueue(filtered), [filtered]);

  /* ---------- filter options ---------- */
  const domainOptions: FilterOption[] = useMemo(
    () =>
      [...new Set(dets.map((d) => domainOf(d.class)))].map((d) => ({
        value: d,
        label: d === "unknown" ? t("confidence.unknown") : t(`disciplines.${d}`, { defaultValue: d }),
      })),
    [dets, t],
  );
  const floorOptions: FilterOption[] = useMemo(
    () =>
      [...new Set([...dets.map((d) => d.floor), ...(row?.sheet.floors ?? [])].filter((f): f is string => Boolean(f)))].map((f) => ({
        value: f,
        label: t(`floors.${f}`, { defaultValue: f }),
      })),
    [dets, row, t],
  );
  const roomOptions: FilterOption[] = useMemo(
    () => [
      ...[...rooms.values()]
        .filter((r) => !filters.floor || r.floor === filters.floor)
        .map((r) => ({ value: r.id, label: r.name ?? `${t("understanding.unnamedRoom")} (${r.id})` })),
      ...(dets.some((d) => d.roomId === null) ? [{ value: "none", label: t("understanding.noRoom") }] : []),
    ],
    [rooms, dets, filters.floor, t],
  );

  /* ---------- overlay features ---------- */
  const markers = useMemo(() => (layers.symbols ? detectionMarkers(filtered, lifecycles) : []), [filtered, lifecycles, layers.symbols]);
  const roomFeatures = useMemo(() => {
    if (!layers.rooms || !data?.rooms) return [];
    const dim = filters.room ? new Set([...rooms.keys()].filter((id) => id !== filters.room)) : null;
    return roomPolygons(data.rooms.rooms, { unnamed: t("understanding.unnamedRoom"), areaUnit: t("understanding.area"), dimIds: dim });
  }, [layers.rooms, data, filters.room, rooms, t]);
  const legendFeatures = useMemo(() => (layers.legend ? legendBoxes(data?.legend ?? null) : []), [layers.legend, data]);
  const features = useMemo(() => overlayFeatures({ rooms: roomFeatures, legend: legendFeatures, markers }), [roomFeatures, legendFeatures, markers]);

  /* ---------- selection ---------- */
  const ctxOf = useCallback(
    (d: Detection): DetectionContext => ({
      room: d.roomId ? (rooms.get(d.roomId) ?? null) : null,
      legendEntry: d.legendEntryId ? (legendEntries.get(d.legendEntryId) ?? null) : null,
      legendThumb: d.legendEntryId ? (thumbs[d.legendEntryId] ?? null) : null,
    }),
    [rooms, legendEntries, thumbs],
  );
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  const selectDetection = (d: Detection | null, jump = false) => {
    setSelectedId(d?.id ?? null);
    setLassoIds([]);
    if (d) {
      setSelectedClass(d.class); // drawing → row
      if (jump) zoomTo([d.bboxMm.x - 25, d.bboxMm.y - 18, d.bboxMm.x + d.bboxMm.w + 25, d.bboxMm.y + d.bboxMm.h + 18]);
    }
  };
  const onSelect = (ids: string[]) => {
    const d = ids[0] ? byId.get(ids[0]) : undefined;
    selectDetection(d ?? null);
  };
  const onSelectClass = (cls: string | null) => {
    setSelectedClass(cls);
    setSelectedId(null);
    if (cls) zoomTo(boundsOf(filtered.filter((d) => d.class === cls), 10));
  };
  const onLasso = (r: LassoResult) => {
    const picked = r.ids.map((id) => byId.get(id)).filter((d): d is Detection => Boolean(d));
    setLassoIds(picked.map((d) => d.id));
    setSelectedId(null);
    const by = countsByClass(picked)
      .map((c) => `${c.total} ${className(c.cls, t("understanding.unknownClass"))}`)
      .join(", ");
    toast({ title: t("viewer.lassoResult", { count: picked.length }), ...(by ? { description: by } : {}) });
  };

  // `[` / `]` step through the selected class's items; Esc closes the popover.
  const step = useCallback(
    (dir: 1 | -1) => {
      if (classItems.length === 0) return;
      const i = classItems.findIndex((d) => d.id === selectedId);
      const next = classItems[(i + dir + classItems.length) % classItems.length]!;
      setSelectedId(next.id);
      zoomTo([next.bboxMm.x - 25, next.bboxMm.y - 18, next.bboxMm.x + next.bboxMm.w + 25, next.bboxMm.y + next.bboxMm.h + 18]);
    },
    [classItems, selectedId, zoomTo],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [role='menu']")) return;
      if (e.code === "BracketRight") step(1);
      else if (e.code === "BracketLeft") step(-1);
      else if (e.code === "Escape" && selectedId) setSelectedId(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, selectedId]);

  const onResolve = async (c: UnknownCluster, cls: string | null, remember: boolean) => {
    if (!row?.version) return;
    const n = clusterMembers.get(c.id)?.length ?? c.count;
    await resolve.mutateAsync({ clusterId: c.id, sheetId: row.sheet.id, versionId: row.version.id, cls, remember });
    toast({
      title: cls ? t("unknown.resolved", { count: n, name: className(cls) }) : t("unknown.ignored", { count: n }),
      tone: "success",
    });
    if (cls) setSelectedClass(cls);
  };

  const renderTooltip = useCallback(
    (id: string) => {
      const d = byId.get(id);
      return d && id !== selectedId ? <DetectionDetails d={d} ctx={ctxOf(d)} compact /> : null;
    },
    [byId, ctxOf, selectedId],
  );
  const popover = selected
    ? {
        anchorMm: [selected.centerMm.x, selected.centerMm.y] as const,
        label: t("understanding.details"),
        content: <DetectionDetails d={selected} ctx={ctxOf(selected)} onClose={() => setSelectedId(null)} />,
      }
    : null;

  const pct = verifiedPct(dets);
  const toReview = dets.filter((d) => levelKeyOf(d) === "red" || levelKeyOf(d) === "unknown").length;
  const pick = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("sheet", id);
    next.delete("bbox");
    for (const k of ["dom", "floor", "room"]) next.delete(k);
    setParams(next, { replace: true });
  };
  const selIndex = selectedId ? classItems.findIndex((d) => d.id === selectedId) : -1;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <nav aria-label={t("review.skipNav")} className="contents">
        <a href="#boq-panel" className="skip-link">{t("review.skipBoq")}</a>
        <a href="#drawing-panel" className="skip-link">{t("review.skipDrawing")}</a>
        <a href="#queue-panel" className="skip-link">{t("review.skipQueue")}</a>
      </nav>

      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-surface px-4">
        <Link to="/projects" className="rounded" aria-label={t("app.name")}>
          <Logo withText={false} />
        </Link>
        <nav aria-label={t("app.breadcrumbs")} className="min-w-0">
          <ol className="flex items-center gap-1.5 text-dense">
            <li>
              <Link to="/projects" className="text-muted-foreground hover:text-foreground">{t("app.name")}</Link>
            </li>
            <li aria-hidden className="text-muted-foreground">‹</li>
            <li>
              <Link to={`/projects/${projectId}`} className="truncate text-muted-foreground hover:text-foreground">{name}</Link>
            </li>
            <li aria-hidden className="text-muted-foreground">‹</li>
            <li aria-current="page" className="font-medium text-foreground">{t("review.title")}</li>
          </ol>
        </nav>
        <div className="flex flex-1 items-center justify-end gap-3">
          <button
            type="button"
            onClick={notYet}
            className="hidden h-8 w-48 items-center gap-2 rounded border border-input bg-surface-sunken px-2.5 text-dense text-muted-foreground hover:border-foreground/30 xl:inline-flex"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="flex-1 text-start">{t("review.search")}</span>
            <Kbd>⌘K</Kbd>
          </button>
          {dets.length ? (
            <div className="hidden w-48 flex-col gap-1 lg:flex">
              <div className="flex items-center justify-between text-meta">
                <span className="font-medium text-foreground">{t("review.verifiedTotal", { pct })}</span>
                <button
                  type="button"
                  onClick={() => setFilters({ ...EMPTY_FILTERS, levels: ["red", "unknown"] })}
                  className="inline-flex items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground"
                >
                  <ConfidenceShape level="low" className="size-2.5" />
                  {t("review.toReview", { count: toReview })}
                </button>
              </div>
              <Progress value={pct} aria-label={t("review.verifiedTotal", { pct })} indicatorClassName="bg-conf-high" />
            </div>
          ) : null}
          <Button size="sm" variant="secondary" asChild>
            <Link to={`/projects/${projectId}/legend`}>
              <BookOpenCheck aria-hidden />
              {t("legend.title")}
            </Link>
          </Button>
          <Button size="sm" variant="secondary" onClick={notYet}>
            <Share2 aria-hidden />
            {t("review.share")}
          </Button>
          <Button size="sm" onClick={notYet}>
            <Download aria-hidden />
            {t("review.export")}
          </Button>
          <UserMenu />
        </div>
      </header>

      <FilterBar
        filters={filters}
        onChange={setFilters}
        domains={domainOptions}
        floors={floorOptions}
        rooms={roomOptions}
        levelCounts={levelCounts}
      />

      {/* Three panes: grid columns follow inline direction → first column is on the right in RTL */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,30fr)_minmax(0,52fr)_minmax(260px,18fr)]">
        <CountsPanel
          counts={counts}
          selectedClass={selectedClass}
          onSelectClass={onSelectClass}
          legendLabel={(id) => (id ? (legendEntries.get(id)?.label ?? null) : null)}
          legendThumb={(id) => (id ? (thumbs[id] ?? null) : null)}
          loading={overlay.isLoading && Boolean(row)}
          error={overlay.isError}
          filtered={isFiltered(filters)}
          onClearFilters={() => setFilters(EMPTY_FILTERS)}
        />
        <section id="drawing-panel" tabIndex={-1} aria-label={t("review.drawingPanel")} className="flex min-h-0 flex-col border-x border-border">
          <ReviewDrawing
            projectId={projectId}
            rows={ready}
            row={row}
            loading={sheets.isLoading}
            onPick={pick}
            overlays={features}
            selectedIds={selectedId ? [selectedId] : lassoIds}
            focusIds={focusIds}
            onSelect={onSelect}
            onLasso={onLasso}
            popover={popover}
            renderTooltip={renderTooltip}
            zoomRequest={zoomRequest}
            initialViewMm={bbox}
            lifecycles={lifecycles}
            onLifecycles={setLifecycles}
            layers={layers}
            onLayers={setLayers}
            openCount={(r) => {
              const s = r.version?.stats?.detections;
              return s ? s.red + s.unknown : null;
            }}
          />
        </section>
        <QueuePanel
          clusters={clusters}
          clusterMembers={clusterMembers}
          thumbs={thumbs}
          queue={queue}
          rooms={rooms}
          activeId={selectedId}
          onJump={(d) => selectDetection(d, true)}
          onResolve={onResolve}
          loading={overlay.isLoading && Boolean(row)}
        />
      </div>

      {/* Selection bar */}
      <footer className="flex h-12 shrink-0 items-center gap-3 border-t border-border bg-surface px-4 text-dense">
        <span className="text-muted-foreground">{t("review.selected")}:</span>
        <span className="min-w-0 truncate font-medium text-foreground" aria-live="polite">
          {selectedClass
            ? t("understanding.selectedClass", { name: className(selectedClass, t("understanding.unknownClass")), count: classItems.length })
            : lassoIds.length
              ? t("viewer.lassoResult", { count: lassoIds.length })
              : <span className="font-normal text-muted-foreground">{t("understanding.nothingSelected")}</span>}
        </span>
        {classItems.length > 0 ? (
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" onClick={() => step(-1)} aria-label={t("understanding.prevItem")} aria-keyshortcuts="BracketLeft">
              <ChevronRight className="ltr:rotate-180" aria-hidden />
            </Button>
            <span className="text-meta text-muted-foreground">
              {t("understanding.itemOf", { i: selIndex >= 0 ? selIndex + 1 : "–", n: classItems.length })}
            </span>
            <Button size="icon-sm" variant="ghost" onClick={() => step(1)} aria-label={t("understanding.nextItem")} aria-keyshortcuts="BracketRight">
              <ChevronLeft className="ltr:rotate-180" aria-hidden />
            </Button>
            <Kbd>[</Kbd>
            <Kbd>]</Kbd>
          </div>
        ) : null}
        <div className="ms-auto flex items-center gap-1.5">
          {[
            { k: "A", label: t("review.approve"), primary: true },
            { k: "R", label: t("review.reject") },
            { k: "E", label: t("review.edit") },
          ].map((a) => (
            <Button key={a.k} size="sm" variant={a.primary ? "primary" : "secondary"} onClick={notYet} aria-keyshortcuts={a.k}>
              <Kbd className={a.primary ? "border-primary-foreground/40 bg-transparent text-primary-foreground" : undefined}>{a.k}</Kbd>
              {a.label}
            </Button>
          ))}
        </div>
      </footer>
    </div>
  );
}

/** Wraps Latin/numeric tokens ("16A", "H=180", "25") in <bdi dir="ltr"> per spec RTL rules. */
export function MixedText({ text }: { text: string }) {
  const parts = text.split(/([A-Za-z0-9][A-Za-z0-9.:=×/+-]*)/g);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <Ltr key={i}>{p}</Ltr> : p))}
    </>
  );
}
