import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpenCheck, ChevronLeft, ChevronRight, Download, Search, Share2 } from "lucide-react";
import type { LassoResult } from "@kamutan/viewer";
import type { BoqLine, Detection, SheetRow, UnknownCluster } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { Logo } from "@/components/Logo";
import { UserMenu } from "@/components/AppShell";
import { ConfidenceShape } from "@/components/ConfidenceBadge";
import { Kbd } from "@/components/Kbd";
import { Ltr } from "@/components/Ltr";
import { useProject } from "@/features/projects/queries";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { useAuthStore } from "@/stores/authStore";
import { BoqPanel, type PanelTab } from "@/features/boq/BoqPanel";
import { OverrideDialog } from "@/features/boq/OverrideDialog";
import { ExportDialog } from "@/features/boq/ExportDialog";
import { ReceiptGroups } from "@/features/boq/ReceiptGroups";
import {
  canEditQty,
  evidenceBySheet,
  filterLines,
  forwardStatus,
  groupByChapter,
  detectionsByLine,
  groupNo,
  groupsOf,
  isCompositeLine,
  linkGroupFeatures,
  nextNeedingReview,
  statsOf,
  type StatusFilter,
} from "@/features/boq/model";
import {
  useSheetEvidence,
  useBoqBuild,
  useBoqLines,
  useBoqState,
  useBuildBoq,
  useLineEvidence,
  usePatchBoqLine,
  useTemplates,
} from "@/features/boq/queries";
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
  // URL updates can follow each other within one render (e.g. "עבור לפריטים" sets lvl=red, then the line's sheet
  // jump sets ?sheet=): always build on the latest params we wrote, not on this render's snapshot.
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);
  const updateParams = useCallback(
    (fn: (p: URLSearchParams) => URLSearchParams) => {
      const next = fn(new URLSearchParams(paramsRef.current));
      paramsRef.current = next;
      setParams(next, { replace: true });
    },
    [setParams],
  );
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

  /* ---------- BOQ (Sprint 3) ---------- */
  const qc = useQueryClient();
  const { org } = useCurrentOrg();
  const role = org?.role ?? null;
  const orgId = project.data?.orgId ?? org?.id ?? null;
  const session = useAuthStore((s) => s.session);
  const tab: PanelTab = params.get("panel") === "counts" ? "counts" : "boq";
  const setTab = (v: PanelTab) =>
    updateParams((next) => {
      if (v === "counts") next.set("panel", "counts");
      else next.delete("panel");
      return next;
    });
  const boqState = useBoqState(orgId, projectId);
  const [activeBuildId, setActiveBuildId] = useState<string | null>(null);
  const build = useBoqBuild(orgId, projectId, activeBuildId);
  const buildBoq = useBuildBoq(projectId);
  const linesQ = useBoqLines(projectId, boqState.data?.latestBuildId);
  const state = boqState.data !== undefined ? boqState.data : (linesQ.data?.boq ?? null);
  const buildId = state?.latestBuildId ?? null;
  const allLines = useMemo(() => (buildId ? (linesQ.data?.items ?? []) : []), [linesQ.data, buildId]);
  const templates = useTemplates(orgId ?? "");
  const chapters = linesQ.data?.chapters ?? templates.data?.find((x) => x.default)?.chapters ?? [];
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [split, setSplit] = useState(false);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [lineSource, setLineSource] = useState<"row" | "drawing">("row");
  const [flashLineId, setFlashLineId] = useState<string | null>(null);
  /** Row → drawing bookkeeping: which line already switched sheet / zoomed (per sheet). */
  const lineView = useRef<{ switched: string | null; zoomed: string | null }>({ switched: null, zoomed: null });
  const [hoverLineId, setHoverLineId] = useState<string | null>(null);
  const [editLine, setEditLine] = useState<BoqLine | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const patchLine = usePatchBoqLine(projectId);
  const evidence = useLineEvidence(projectId, selectedLineId, buildId);
  const sheetEvidence = useSheetEvidence(projectId, tab === "boq" ? (row?.sheet.id ?? null) : null, row?.version?.id ?? null, buildId);
  const detToLines = sheetEvidence.data?.detections;
  const lineToDets = useMemo(() => detectionsByLine(sheetEvidence.data?.detections ?? {}), [sheetEvidence.data]);
  const selectedLine = allLines.find((l) => l.id === selectedLineId) ?? null;

  // Build finished → refresh lines, links (overlay) and evidence; toast.
  const lastBuildStatus = useRef<string | null>(null);
  useEffect(() => {
    const st = build.data?.status ?? null;
    if (st && st !== lastBuildStatus.current && lastBuildStatus.current && (st === "succeeded" || st === "failed")) {
      void qc.invalidateQueries({ queryKey: ["overlay", projectId] });
      void qc.invalidateQueries({ queryKey: ["boq-lines", projectId] });
      if (st === "succeeded") toast({ title: t("boq.buildDone", { count: build.data?.stats?.lines ?? 0 }), tone: "success" });
    }
    lastBuildStatus.current = st;
  }, [build.data, qc, projectId, t]);
  const onBuild = async () => {
    try {
      const res = await buildBoq.mutateAsync();
      setActiveBuildId(res.buildId);
    } catch {
      toast({ title: t("boq.buildFailed"), tone: "error" });
    }
  };

  /* ---------- overlay + view state ---------- */
  const overlay = useOverlay(projectId, row);
  const resolve = useResolveCluster(projectId);
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const setFilters = (f: OverlayFilters) => updateParams((p) => filtersToParams(f, p));
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
  const lineEvidence = useMemo(() => (selectedLineId ? (evidence.data?.items ?? []) : []), [selectedLineId, evidence.data]);
  const evidenceSheets = useMemo(() => evidenceBySheet(lineEvidence), [lineEvidence]);
  const lineItems = useMemo(() => {
    if (!row) return [];
    const ids = new Set(lineEvidence.filter((e) => e.sheetId === row.sheet.id).map((e) => e.detectionId));
    return dets.filter((d) => ids.has(d.id));
  }, [lineEvidence, row, dets]);
  const hoverIds = useMemo(() => {
    if (!hoverLineId || hoverLineId === selectedLineId || !row) return null;
    return lineToDets.get(hoverLineId) ?? null;
  }, [hoverLineId, selectedLineId, lineToDets, row]);
  /** Items the `[` `]` stepper walks: the selected line's evidence on this sheet, else the selected class. */
  const stepItems = selectedLineId ? lineItems : classItems;
  const focusIds = useMemo(() => hoverIds ?? stepItems.map((d) => d.id), [hoverIds, stepItems]);
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
  const linkGroups = useMemo(() => {
    const groups = data?.links?.groups ?? [];
    if (!groups.length) return [];
    if (selectedLineId) {
      const ids = new Set(lineEvidence.filter((e) => e.sheetId === row?.sheet.id && e.linkGroupId).map((e) => e.linkGroupId));
      return groups.filter((g) => ids.has(g.id));
    }
    if (selectedId) return groups.filter((g) => g.switchIds.includes(selectedId) || g.luminaireIds.includes(selectedId));
    return [];
  }, [data, selectedLineId, lineEvidence, row, selectedId]);
  const groupFeatures = useMemo(() => {
    if (!linkGroups.length) return [];
    const arcsById = new Map((data?.links?.arcs ?? []).map((a) => [a.id, a]));
    const codeOf = (gid: string) => selectedLine?.code ?? allLines.find((l) => l.id === sheetEvidence.data?.linkGroups[gid]?.[0])?.code ?? "";
    return linkGroupFeatures(linkGroups, byId, (g) => ({
      short: t("boq.groupShort", { n: groupNo(g.id) }),
      code: codeOf(g.id),
      detail:
        g.switchIds.length === 0
          ? t("boq.groupDetailSensor", { lum: t("boq.groupLum", { count: g.luminaireIds.length }) })
          : t("boq.groupDetail", { lum: t("boq.groupLum", { count: g.luminaireIds.length }), sw: t("boq.groupSw", { count: g.switchIds.length }) }),
    }), arcsById);
  }, [linkGroups, data, byId, selectedLine, allLines, sheetEvidence.data, t]);
  const features = useMemo(
    () => [...overlayFeatures({ rooms: roomFeatures, legend: legendFeatures, markers: [] }), ...groupFeatures, ...markers],
    [roomFeatures, legendFeatures, markers, groupFeatures],
  );

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
    // Drawing → row (BOQ tab): select the marker's line(s); a second click on a shared item cycles its lines.
    if (d && row && tab === "boq") {
      const lineIds = detToLines?.[d.id] ?? [];
      if (lineIds.length) {
        const i = selectedLineId ? lineIds.indexOf(selectedLineId) : -1;
        const next = i >= 0 && lineIds.length > 1 ? lineIds[(i + 1) % lineIds.length]! : i >= 0 ? selectedLineId! : lineIds[0]!;
        setLineSource("drawing");
        setSelectedLineId(next);
        setFlashLineId(null);
        queueMicrotask(() => setFlashLineId(next));
      }
    }
  };
  const selectLine = useCallback((id: string | null) => {
    lineView.current = { switched: null, zoomed: null };
    setLineSource("row");
    setSelectedLineId(id);
    setSelectedId(null);
    setSelectedClass(null);
    setLassoIds([]);
  }, []);

  // Row → drawing: when the line's evidence is not on this sheet, jump to the sheet with most of it (+ toast);
  // then zoom to the bounds of its items on the sheet. Drawing-originated selections never move the view.
  useEffect(() => {
    if (!selectedLineId || lineSource !== "row" || !row || !evidence.data || evidence.data.lineId !== selectedLineId) return;
    const here = evidenceSheets.get(row.sheet.id) ?? 0;
    if (here === 0 && evidenceSheets.size) {
      if (lineView.current.switched === selectedLineId) return;
      const best = [...evidenceSheets.entries()].sort((a, b) => b[1] - a[1])[0]!;
      const target = ready.find((r) => r.sheet.id === best[0]);
      if (target) {
        lineView.current.switched = selectedLineId;
        pick(target.sheet.id);
        toast({ title: t("boq.switchedSheet", { sheet: sheetName(target) }) });
      }
      return;
    }
    const key = `${selectedLineId}@${row.sheet.id}`;
    if (lineItems.length && lineView.current.zoomed !== key) {
      lineView.current.zoomed = key;
      zoomTo(boundsOf(lineItems, 12));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLineId, lineSource, evidence.data, evidenceSheets, row, lineItems]);
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

  /* ---------- line actions: A (status forward), E (qty override), N (next needing review) ---------- */
  const visibleLines = useMemo(() => filterLines(allLines, filters, statusFilter), [allLines, filters, statusFilter]);
  const ordered = useMemo(() => groupByChapter(visibleLines, chapters).flatMap((g) => g.lines), [visibleLines, chapters]);
  const advance = (l: BoqLine) => {
    const to = forwardStatus(role, l.status);
    if (!to) return toast({ title: t("boq.statusNotAllowed"), tone: "error" });
    const when = new Date().toLocaleString("he-IL", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", "");
    patchLine.mutate(
      { id: l.id, req: { status: to } },
      {
        onSuccess: () =>
          toast({
            title: t("boq.markedStatus", { code: l.code, status: t(`boq.status.${to}`), who: session?.displayName ?? session?.email ?? "", when }),
            tone: "success",
          }),
        onError: () => toast({ title: t("boq.patchError"), tone: "error" }),
      },
    );
  };
  const goNext = () => {
    const n = nextNeedingReview(ordered, selectedLineId);
    if (!n) return toast({ title: t("boq.noneToReview") });
    selectLine(n.id);
  };
  const saveOverride = (qtyOverride: number | null, reason: string | null) => {
    const l = editLine;
    if (!l) return;
    patchLine.mutate(
      { id: l.id, req: qtyOverride === null ? { qtyOverride: null } : { qtyOverride, reason: reason ?? "" } },
      {
        onSuccess: (res) => {
          setEditLine(null);
          toast({
            title: qtyOverride === null ? t("boq.override.cleared", { code: l.code }) : t("boq.override.saved", { code: l.code, qty: res.qtyOverride ?? qtyOverride }),
            tone: "success",
          });
        },
        onError: () => toast({ title: t("boq.patchError"), tone: "error" }),
      },
    );
  };

  // `[` / `]` step through the selected class's items; Esc closes the popover.
  const step = useCallback(
    (dir: 1 | -1) => {
      if (stepItems.length === 0) return;
      const i = stepItems.findIndex((d) => d.id === selectedId);
      const next = stepItems[(i + dir + stepItems.length) % stepItems.length]!;
      setSelectedId(next.id);
      zoomTo([next.bboxMm.x - 25, next.bboxMm.y - 18, next.bboxMm.x + next.bboxMm.w + 25, next.bboxMm.y + next.bboxMm.h + 18]);
    },
    [stepItems, selectedId, zoomTo],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [role='menu']")) return;
      if (e.code === "BracketRight") step(1);
      else if (e.code === "BracketLeft") step(-1);
      else if (e.code === "Escape" && selectedId) setSelectedId(null);
      else if (e.code === "KeyA" && !e.shiftKey && selectedLine) advance(selectedLine);
      else if (e.code === "KeyE" && !e.shiftKey && selectedLine && canEditQty(role)) setEditLine(selectedLine);
      else if (e.code === "KeyN" && !e.shiftKey && tab === "boq" && allLines.length) goNext();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selectedId, selectedLine, role, tab, allLines]);

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

  const lineStats = statsOf(allLines);
  const pct = allLines.length ? lineStats.pct : verifiedPct(dets);
  const toReview = allLines.length ? lineStats.red : dets.filter((d) => levelKeyOf(d) === "red" || levelKeyOf(d) === "unknown").length;
  const pick = (id: string) =>
    updateParams((next) => {
      next.set("sheet", id);
      next.delete("bbox");
      for (const k of ["dom", "floor", "room"]) next.delete(k);
      return next;
    });
  const selIndex = selectedId ? stepItems.findIndex((d) => d.id === selectedId) : -1;
  const lineGroupsCount = groupsOf(lineEvidence).length;

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
          {dets.length || allLines.length ? (
            <div className="hidden w-48 flex-col gap-1 lg:flex">
              <div className="flex items-center justify-between text-meta">
                <span className="font-medium text-foreground">{t("review.verifiedTotal", { pct })}</span>
                <button
                  type="button"
                  onClick={() => setFilters({ ...EMPTY_FILTERS, levels: allLines.length ? ["red"] : ["red", "unknown"] })}
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
          <Button size="sm" onClick={() => setExportOpen(true)}>
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
        <BoqPanel
          tab={tab}
          onTab={setTab}
          counts={
            <CountsPanel
              counts={counts}
              selectedClass={selectedClass}
              onSelectClass={(c) => {
                setSelectedLineId(null);
                onSelectClass(c);
              }}
              legendLabel={(id) => (id ? (legendEntries.get(id)?.label ?? null) : null)}
              legendThumb={(id) => (id ? (thumbs[id] ?? null) : null)}
              loading={overlay.isLoading && Boolean(row)}
              error={overlay.isError}
              filtered={isFiltered(filters)}
              onClearFilters={() => setFilters(EMPTY_FILTERS)}
            />
          }
          state={state}
          build={build.data ?? null}
          onBuild={() => void onBuild()}
          buildPending={buildBoq.isPending || (Boolean(activeBuildId) && build.data === undefined)}
          canBuild={role !== "viewer"}
          hasReadySheets={ready.length > 0}
          lines={visibleLines}
          totalLines={allLines.length}
          chapters={chapters}
          loading={linesQ.isLoading}
          error={linesQ.isError}
          selectedLineId={selectedLineId}
          onSelectLine={selectLine}
          onHoverLine={setHoverLineId}
          renderReceiptExtra={(l) => (
            <ReceiptGroups
              projectId={projectId}
              buildId={buildId}
              lineId={l.id}
              sheetLabel={(id) => {
                const r = ready.find((x) => x.sheet.id === id);
                return r ? sheetName(r) : id;
              }}
            />
          )}
          flashLineId={flashLineId}
          split={split}
          onSplit={setSplit}
          statusFilter={statusFilter}
          onStatusFilter={setStatusFilter}
          filtered={isFiltered(filters) || statusFilter !== "all"}
          onClearFilters={() => {
            setFilters(EMPTY_FILTERS);
            setStatusFilter("all");
          }}
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
            sheetBadge={(r) => {
              if (selectedLineId && evidence.data) {
                const n = evidenceSheets.get(r.sheet.id) ?? 0;
                return n ? t(selectedLine && isCompositeLine(selectedLine) ? "boq.sheetGroups" : "boq.sheetEvidence", { count: n }) : null;
              }
              const s = r.version?.stats?.detections;
              return s && s.red + s.unknown ? t("review.toReview", { count: s.red + s.unknown }) : null;
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
          {selectedLine ? (
            <>
              <Ltr>{selectedLine.code}</Ltr>
              {" · "}
              {[
                lineGroupsCount ? t("boq.groups", { count: lineGroupsCount }) : null,
                t("boq.items", { count: lineEvidence.length || selectedLine.evidenceCount }),
                row && lineEvidence.length && lineItems.length !== lineEvidence.length ? t("boq.evidenceOnSheet", { n: lineItems.length }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </>
          ) : selectedClass
            ? t("understanding.selectedClass", { name: className(selectedClass, t("understanding.unknownClass")), count: classItems.length })
            : lassoIds.length
              ? t("viewer.lassoResult", { count: lassoIds.length })
              : <span className="font-normal text-muted-foreground">{t("understanding.nothingSelected")}</span>}
        </span>
        {stepItems.length > 0 ? (
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" onClick={() => step(-1)} aria-label={t("understanding.prevItem")} aria-keyshortcuts="BracketLeft">
              <ChevronRight className="ltr:rotate-180" aria-hidden />
            </Button>
            <span className="text-meta text-muted-foreground">
              {t("understanding.itemOf", { i: selIndex >= 0 ? selIndex + 1 : "–", n: stepItems.length })}
            </span>
            <Button size="icon-sm" variant="ghost" onClick={() => step(1)} aria-label={t("understanding.nextItem")} aria-keyshortcuts="BracketRight">
              <ChevronLeft className="ltr:rotate-180" aria-hidden />
            </Button>
            <Kbd>[</Kbd>
            <Kbd>]</Kbd>
          </div>
        ) : null}
        <div className="ms-auto flex items-center gap-1.5">
          {tab === "boq" && buildId ? (
            <>
              {(() => {
                const to = selectedLine ? forwardStatus(role, selectedLine.status) : null;
                return (
                  <Button
                    size="sm"
                    disabled={!selectedLine || !to}
                    onClick={() => selectedLine && advance(selectedLine)}
                    aria-keyshortcuts="A"
                  >
                    <Kbd className="border-primary-foreground/40 bg-transparent text-primary-foreground">A</Kbd>
                    {to ? t("boq.approveLine", { status: t(`boq.status.${to}`) }) : t("review.approve")}
                  </Button>
                );
              })()}
              <Button
                size="sm"
                variant="secondary"
                disabled={!selectedLine || !canEditQty(role)}
                onClick={() => selectedLine && setEditLine(selectedLine)}
                aria-keyshortcuts="E"
              >
                <Kbd>E</Kbd>
                {t("boq.editQty")}
              </Button>
              <Button size="sm" variant="secondary" onClick={goNext} aria-keyshortcuts="N">
                <Kbd>N</Kbd>
                {t("boq.nextLine")}
              </Button>
            </>
          ) : (
            [
              { k: "A", label: t("review.approve"), primary: true },
              { k: "R", label: t("review.reject") },
              { k: "E", label: t("review.edit") },
            ].map((a) => (
              <Button key={a.k} size="sm" variant={a.primary ? "primary" : "secondary"} onClick={notYet} aria-keyshortcuts={a.k}>
                <Kbd className={a.primary ? "border-primary-foreground/40 bg-transparent text-primary-foreground" : undefined}>{a.k}</Kbd>
                {a.label}
              </Button>
            ))
          )}
        </div>
      </footer>

      <OverrideDialog
        line={editLine}
        open={editLine !== null}
        onOpenChange={(o) => !o && setEditLine(null)}
        onSave={saveOverride}
        saving={patchLine.isPending}
      />
      <ExportDialog
        projectId={projectId}
        open={exportOpen}
        onOpenChange={setExportOpen}
        lines={allLines}
        templates={templates.data ?? []}
        blockOnRed={Boolean(org?.settings?.blockExportOnRed || linesQ.data?.blockExportOnRed)}
        built={Boolean(buildId)}
        onGoToItems={() => {
          updateParams((p) => {
            const next = filtersToParams({ ...EMPTY_FILTERS, levels: ["red"] }, p);
            next.delete("panel");
            return next;
          });
          const first = allLines.find((l) => l.level === "red" && l.status !== "approved");
          if (first) selectLine(first.id);
        }}
      />
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
