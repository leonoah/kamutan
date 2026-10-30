import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpenCheck, ChevronLeft, ChevronRight, Download, History, Search, Share2, Sparkles } from "lucide-react";
import type { AreaResult, CalibrationResult, CountResult, LassoResult, LengthResult, LinkResult, MoveResult, PointToolEvent, Vec2, ViewerTool } from "@kamutan/viewer";
import type { BoqChapter, BoqLine, CreateCorrectionRequest, Detection, ReviewQueueItem, RoomSettings, SheetRow, SimilarCandidate, SimilarSearch, UnknownCluster } from "@/api/types";
import { useApi } from "@/api/client";
import { useLatestFns } from "@/lib/useLatestFns";
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
import { CalibrationBadge, cappedLines, resolveCalibration } from "@/features/calibration/CalibrationBadge";
import { LineHistoryDialog } from "@/features/history/LineHistoryDialog";
import { ShareDialog } from "@/features/share/ShareDialog";
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
  lineDomain,
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
  polygonBBox,
  countsByClass,
  detectionMarkers,
  filtersFromParams,
  filtersToParams,
  isFiltered,
  legendBoxes,
  levelKeyOf,
  overlayFeatures,
  roomPolygons,
  roomsById,
  verifiedPct,
  type LevelKey,
  type LifecycleVisibility,
  type OverlayFilters,
} from "@/features/understanding/model";
import { useOverlay, useResolveCluster } from "@/features/understanding/queries";
import { className, domainOf } from "@/features/understanding/taxonomy";
import { useLibraryItems } from "@/features/boq/queries";
import { applyCorrections, applyLinkCorrections, baseCorrection, manualItems, newId } from "@/features/corrections/model";
import {
  useCorrectionActions,
  useCorrections,
  useFindSimilar,
  useHistory,
  usePutRoomSettings,
  useReviewQueue,
  useRevertCorrection,
  useRoomSettings,
  useSimilarSearch,
} from "@/features/corrections/queries";
import { RoomPanel } from "@/features/tiling/RoomPanel";
import { defaultSettings, wallsOf } from "@/features/tiling/model";
import { CountsPanel } from "./CountsPanel";
import { DetectionDetails, type DetectionContext } from "./DetectionDetails";
import { FilterBar, type FilterOption } from "./FilterBar";
import { ReviewQueuePanel } from "./ReviewQueuePanel";
import { REVIEW_TOOLS, ReviewDrawing, parseBBox, type LayerVisibility } from "./ReviewDrawing";
import { toolForKey } from "@/features/viewer/tools";
import { OptionPicker, classOptions, type PickerOption } from "./ClassPicker";
import { LassoCard, ShortcutsDialog } from "./ReviewDialogs";
import { LearnPanel } from "./LearnPanel";
import { bboxCenter, candidateFeatures, manualItemFeatures, nearestWall, padBBox, roomAt, roomFeatures as selectedRoomFeatures } from "./overlay";

/** Picker state: what the chosen class is for. */
type PickerState =
  | { mode: "queue"; item: ReviewQueueItem }
  | { mode: "detections"; ids: string[] }
  | { mode: "add"; mm: [number, number] }
  | { mode: "resolve"; cluster: UnknownCluster };
/** Manual quantity waiting for its BOQ item (count / area / length). */
type AssignState = { kind: "count" | "area" | "length"; qty: number; unit: string; pointsMm: [number, number][]; sheetId: string; versionId: string };

/** Speed protocol hook (mock/dev builds only): keydown → next painted frame latency per queue action. */
declare global {
  interface Window {
    __kamutanQueue?: { latencies: number[]; actions: number; remaining: () => number };
  }
}

/** Picker order: sheets with detections first, then electrical, lighting, the rest (by name). */
const rank = (r: SheetRow) =>
  (r.version?.artifacts?.detections ? 0 : 10) + (r.sheet.discipline === "electrical" ? 0 : r.sheet.discipline === "lighting" ? 1 : 2);

/**
 * S10 "סביבת הבדיקה" — Sprint 2: the drawing shows the worker's understanding of the current sheet
 * (detections ●▲◆◇, rooms, legend), the right pane counts by class (the BOQ table lands in Sprint 3) and the
 * left pane asks "מה זה?" once per unknown cluster, then lists the items to review.
 * Panel order in RTL reading order: counts (right) · drawing (center, LTR) · queue (left).
 */
const NO_CHAPTERS: BoqChapter[] = [];

/**
 * Two routes share this workspace:
 *  - `/projects/:projectId/review` — the project BOQ review (all sheets, sheet picker, ?sheet= in the URL);
 *  - `/projects/:projectId/sheets/:sheetId` — "ניתוח שרטוט": the same tools locked to one sheet, with the
 *    components map (ספירה לפי סוג) as the default panel and the queue / BOQ scoped to that sheet.
 */
export function ReviewPage() {
  const { projectId = "", sheetId: lockedSheetId } = useParams();
  const locked = Boolean(lockedSheetId);
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
  const wanted = lockedSheetId ?? params.get("sheet");
  const row = ready.find((r) => r.sheet.id === wanted) ?? (locked ? null : (ready[0] ?? null));
  const bboxParam = row && row.sheet.id === wanted ? params.get("bbox") : null;
  const bbox = useMemo(() => parseBBox(bboxParam), [bboxParam]);

  /* ---------- BOQ (Sprint 3) ---------- */
  const qc = useQueryClient();
  const { org } = useCurrentOrg();
  const role = org?.role ?? null;
  const orgId = project.data?.orgId ?? org?.id ?? null;
  const session = useAuthStore((s) => s.session);
  // Sheet analysis opens on the components map; the project review on the BOQ.
  const defaultTab: PanelTab = locked ? "counts" : "boq";
  const panelParam = params.get("panel");
  const tab: PanelTab = panelParam === "counts" ? "counts" : panelParam === "boq" ? "boq" : defaultTab;
  const setTab = (v: PanelTab) =>
    updateParams((next) => {
      if (v === defaultTab) next.delete("panel");
      else next.set("panel", v);
      return next;
    });
  const boqState = useBoqState(orgId, projectId);
  const [activeBuildId, setActiveBuildId] = useState<string | null>(null);
  const build = useBoqBuild(orgId, projectId, activeBuildId);
  const buildBoq = useBuildBoq(projectId);
  const linesQ = useBoqLines(projectId, boqState.data?.latestBuildId);
  const state = boqState.data !== undefined ? boqState.data : (linesQ.data?.boq ?? null);
  const buildId = state?.latestBuildId ?? null;
  const allLines = useMemo(() => {
    const items = buildId ? (linesQ.data?.items ?? []) : [];
    // Sheet analysis: only the lines this sheet contributes to.
    return lockedSheetId ? items.filter((l) => l.sourceVersions.some((v) => v.sheetId === lockedSheetId)) : items;
  }, [linesQ.data, buildId, lockedSheetId]);
  const templates = useTemplates(orgId ?? "");
  const chapters = linesQ.data?.chapters ?? templates.data?.find((x) => x.default)?.chapters ?? NO_CHAPTERS;
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [split, setSplit] = useState(false);
  const [showOrder, setShowOrder] = useState(false);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [lineSource, setLineSource] = useState<"row" | "drawing">("row");
  const [flashLineId, setFlashLineId] = useState<string | null>(null);
  /** Row → drawing bookkeeping: which line already switched sheet / zoomed (per sheet). */
  const lineView = useRef<{ switched: string | null; zoomed: string | null }>({ switched: null, zoomed: null });
  const [hoverLineId, setHoverLineId] = useState<string | null>(null);
  const [editLine, setEditLine] = useState<BoqLine | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyLine, setHistoryLine] = useState<BoqLine | null>(null);
  const patchLine = usePatchBoqLine(projectId);
  const evidence = useLineEvidence(projectId, selectedLineId, buildId);
  const sheetEvidence = useSheetEvidence(projectId, tab === "boq" ? (row?.sheet.id ?? null) : null, row?.version?.id ?? null, buildId);
  const detToLines = sheetEvidence.data?.detections;
  const lineToDets = useMemo(() => detectionsByLine(sheetEvidence.data?.detections ?? {}), [sheetEvidence.data]);
  const selectedLine = allLines.find((l) => l.id === selectedLineId) ?? null;
  /* ---------- Sprint 5: calibration badge (header + BOQ panel) ---------- */
  const calibration = useMemo(() => resolveCalibration(linesQ.data?.calibration ?? build.data?.stats?.calibration, ready), [linesQ.data, build.data, ready]);
  const capped = useMemo(() => cappedLines(allLines), [allLines]);
  const sheetNames = useMemo(() => Object.fromEntries(ready.map((r) => [r.sheet.id, sheetName(r)])), [ready]);
  const greenThreshold = org?.settings?.greenThreshold ?? null;
  const panelBadge = useMemo(
    () => <CalibrationBadge calibration={calibration} capped={capped} greenThreshold={greenThreshold} size="sm" />,
    [calibration, capped, greenThreshold],
  );

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
  const [layers, setLayers] = useState<LayerVisibility>({ symbols: true, rooms: true, legend: true, rejected: false });
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
  /* ---------- Sprint 4: corrections applied on top of the worker's detections (optimistic) ---------- */
  const corrQ = useCorrections(projectId);
  const corrections = useMemo(() => corrQ.data ?? [], [corrQ.data]);
  const sheetIdNow = row?.sheet.id ?? "";
  const applied = useMemo(
    () => applyCorrections(data?.detections?.detections ?? [], corrections, sheetIdNow),
    [data, corrections, sheetIdNow],
  );
  /** All items incl. rejected ones (the "נדחו" layer); `dets` = what counts. */
  const allDets = applied.detections;
  const dets = useMemo(() => allDets.filter((d) => !d.rejected), [allDets]);
  const links = useMemo(() => applyLinkCorrections(data?.links ?? null, corrections, sheetIdNow), [data, corrections, sheetIdNow]);
  const rooms = useMemo(() => roomsById(data?.rooms ?? null), [data]);
  const legendEntries = useMemo(() => new Map((data?.legend?.entries ?? []).map((e) => [e.id, e])), [data]);
  const thumbs = data?.manifest.thumbs ?? {};
  const filtered = useMemo(() => applyFilters(dets, filters), [dets, filters]);
  const counts = useMemo(() => countsByClass(filtered), [filtered]);
  const byId = useMemo(() => new Map(allDets.map((d) => [d.id, d])), [allDets]);
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
  /**
   * Area / length lines (tiling, flooring, corners…) are computed from ROOMS: the worker writes the room id as the
   * evidence `detectionId` (units.room_det). Those are highlighted as polygons, not markers.
   */
  const lineRooms = useMemo(() => {
    if (!row) return [];
    const ids = new Set(lineEvidence.filter((e) => e.sheetId === row.sheet.id).map((e) => e.roomId ?? e.detectionId));
    return [...rooms.values()].filter((r) => ids.has(r.id));
  }, [lineEvidence, row, rooms]);
  const hoverIds = useMemo(() => {
    if (!hoverLineId || hoverLineId === selectedLineId || !row) return null;
    return lineToDets.get(hoverLineId) ?? null;
  }, [hoverLineId, selectedLineId, lineToDets, row]);
  /** Items the `[` `]` stepper walks: the selected line's evidence on this sheet, else the selected class. */
  const stepItems = selectedLineId ? lineItems : classItems;
  const baseFocus = useMemo(
    () => hoverIds ?? [...stepItems.map((d) => d.id), ...(selectedLineId ? lineRooms.map((r) => r.id) : [])],
    [hoverIds, stepItems, selectedLineId, lineRooms],
  );
  const clusters = useMemo(() => data?.detections?.unknownClusters ?? [], [data]);
  const clusterMembers = useMemo(() => {
    const m = new Map<string, Detection[]>();
    for (const d of dets) if (d.clusterId) m.set(d.clusterId, [...(m.get(d.clusterId) ?? []), d]);
    return m;
  }, [dets]);

  /* ---------- Sprint 4 state: queue, tools, pickers, learn, room ---------- */
  const api = useApi();
  const [tool, setTool] = useState<ViewerTool>("select");
  const queueQ = useReviewQueue(projectId, buildId);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<ReadonlySet<string>>(new Set());
  const [exceptions, setExceptions] = useState<Record<string, string[]>>({});
  const [hoverMember, setHoverMember] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [assign, setAssign] = useState<AssignState | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [addClass, setAddClass] = useState<string | null>(null);
  const [lassoOpen, setLassoOpen] = useState(false);
  const [learnOffer, setLearnOffer] = useState<{ sheetId: string; versionId: string; bboxMm: Detection["bboxMm"]; cls: string; detectionId: string | null } | null>(null);
  const [learnCls, setLearnCls] = useState<string | null>(null);
  const [learnStart, setLearnStart] = useState<SimilarSearch | null>(null);
  const [learnSel, setLearnSel] = useState<SimilarCandidate[]>([]);
  const findSimilar = useFindSimilar(projectId);
  const learnQ = useSimilarSearch(projectId, learnStart);
  const [roomSel, setRoomSel] = useState<{ sheetId: string; roomId: string } | null>(null);
  const [pickingWall, setPickingWall] = useState(false);
  const [wallPick, setWallPick] = useState<{ wallId: string; seq: number } | null>(null);
  const [roomDraft, setRoomDraft] = useState<RoomSettings | null>(null);
  const roomSettingsQ = useRoomSettings(projectId, roomSel?.sheetId ?? null, roomSel?.roomId ?? null);
  const putRoom = usePutRoomSettings(projectId);
  const [helpOpen, setHelpOpen] = useState(false);
  const [scaleOverride, setScaleOverride] = useState<Record<string, number>>({});
  const [liveMsg, setLiveMsg] = useState("");
  const history = useHistory(projectId);
  const actions = useCorrectionActions(projectId, { onError: () => toast({ title: t("queue.saveError"), tone: "error" }) });
  const revertCorrection = useRevertCorrection(projectId);
  const library = useLibraryItems(orgId ?? "", {});
  const scale = row ? (scaleOverride[row.sheet.id] ?? row.sheet.scaleDenominator ?? null) : null;
  const selRoom = roomSel && row && roomSel.sheetId === row.sheet.id ? (rooms.get(roomSel.roomId) ?? null) : null;
  const selRoomWalls = useMemo(() => (selRoom ? wallsOf(selRoom, scale) : []), [selRoom, scale]);
  const savedRoom = roomSettingsQ.data && !roomSettingsQ.data.isDefault ? roomSettingsQ.data.settings : null;
  const manual = useMemo(() => manualItems(corrections, sheetIdNow), [corrections, sheetIdNow]);
  const queueItems = useMemo(() => {
    const lv = new Set(filters.levels);
    const dom = new Set(filters.domains);
    return (queueQ.data?.items ?? []).filter(
      (i) =>
        !doneIds.has(i.id) &&
        (lv.has(i.level) || i.kind === "room" || i.kind === "line") &&
        (dom.size === 0 || !i.class || dom.has(domainOf(i.class))) &&
        (!lockedSheetId || !i.sheetId || i.sheetId === lockedSheetId),
    );
  }, [queueQ.data, doneIds, filters, lockedSheetId]);
  const activeItem = queueItems.find((i) => i.id === activeItemId) ?? null;
  const rowsById = useMemo(() => new Map(ready.map((r) => [r.sheet.id, r])), [ready]);
  const snapPoints = useMemo<Vec2[]>(
    () => [...rooms.values()].flatMap((r) => r.polygonMm.map((p) => [p.x, p.y] as Vec2)),
    [rooms],
  );
  /** Focus: hovered cluster thumbnail > hovered BOQ row > selected line/class > the active queue item's items. */
  const focusIds = useMemo(() => {
    if (hoverMember) return [hoverMember];
    if (baseFocus.length || hoverIds) return baseFocus;
    if (activeItem && activeItem.sheetId === sheetIdNow && activeItem.kind !== "detection") return activeItem.detectionIds ?? [];
    return baseFocus;
  }, [hoverMember, baseFocus, hoverIds, activeItem, sheetIdNow]);

  /* ---------- filter options ---------- */
  const domainOptions: FilterOption[] = useMemo(
    () =>
      [...new Set([...dets.map((d) => domainOf(d.class)), ...allLines.map((l) => lineDomain(l)).filter((d) => d !== "other")])].map((d) => ({
        value: d,
        label: d === "unknown" ? t("confidence.unknown") : t(`disciplines.${d}`, { defaultValue: d }),
      })),
    [dets, allLines, t],
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
  const rejectedShown = useMemo(() => (layers.rejected ? applyFilters(allDets.filter((d) => d.rejected), { ...filters, levels: [...LEVEL_KEYS] }) : []), [layers.rejected, allDets, filters]);
  const markers = useMemo(
    () => (layers.symbols ? detectionMarkers([...filtered, ...rejectedShown], lifecycles) : []),
    [filtered, rejectedShown, lifecycles, layers.symbols],
  );
  const roomFeatures = useMemo(() => {
    if (!data?.rooms) return [];
    const opts = { unnamed: t("understanding.unnamedRoom"), areaUnit: t("understanding.area") };
    if (!layers.rooms) return lineRooms.length ? roomPolygons(lineRooms, opts) : [];
    const dim = filters.room ? new Set([...rooms.keys()].filter((id) => id !== filters.room)) : null;
    return roomPolygons(data.rooms.rooms, { ...opts, dimIds: dim });
  }, [layers.rooms, data, filters.room, rooms, lineRooms, t]);
  const legendFeatures = useMemo(() => (layers.legend ? legendBoxes(data?.legend ?? null) : []), [layers.legend, data]);
  const linkGroups = useMemo(() => {
    const groups = links?.groups ?? [];
    if (!groups.length) return [];
    if (selectedLineId) {
      const ids = new Set(lineEvidence.filter((e) => e.sheetId === row?.sheet.id && e.linkGroupId).map((e) => e.linkGroupId));
      return groups.filter((g) => ids.has(g.id));
    }
    if (selectedId) return groups.filter((g) => g.switchIds.includes(selectedId) || g.luminaireIds.includes(selectedId));
    return [];
  }, [links, selectedLineId, lineEvidence, row, selectedId]);
  const groupFeatures = useMemo(() => {
    if (!linkGroups.length) return [];
    const arcsById = new Map((links?.arcs ?? []).map((a) => [a.id, a]));
    const codeOf = (gid: string) => selectedLine?.code ?? allLines.find((l) => l.id === sheetEvidence.data?.linkGroups[gid]?.[0])?.code ?? "";
    return linkGroupFeatures(linkGroups, byId, (g) => ({
      short: t("boq.groupShort", { n: groupNo(g.id) }),
      code: codeOf(g.id),
      detail:
        g.switchIds.length === 0
          ? t("boq.groupDetailSensor", { lum: t("boq.groupLum", { count: g.luminaireIds.length }) })
          : t("boq.groupDetail", { lum: t("boq.groupLum", { count: g.luminaireIds.length }), sw: t("boq.groupSw", { count: g.switchIds.length }) }),
    }), arcsById);
  }, [linkGroups, links, byId, selectedLine, allLines, sheetEvidence.data, t]);
  const features = useMemo(
    () => [
      ...overlayFeatures({ rooms: roomFeatures, legend: legendFeatures, markers: [] }),
      ...(selRoom ? selectedRoomFeatures(selRoom, selRoomWalls, roomDraft, pickingWall) : []),
      ...groupFeatures,
      ...manualItemFeatures(manual),
      ...(learnCls ? candidateFeatures(learnSel, sheetIdNow) : []),
      ...markers,
    ],
    [roomFeatures, legendFeatures, markers, groupFeatures, selRoom, selRoomWalls, roomDraft, pickingWall, manual, learnCls, learnSel, sheetIdNow],
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
  const [showPopover, setShowPopover] = useState(true);

  const selectDetection = (d: Detection | null, jump = false) => {
    setShowPopover(true);
    setSelectedId(d?.id ?? null);
    setLassoIds([]);
    if (d) {
      setSelectedClass(d.class); // drawing → row
      if (jump) zoomTo([d.bboxMm.x - 25, d.bboxMm.y - 18, d.bboxMm.x + d.bboxMm.w + 25, d.bboxMm.y + d.bboxMm.h + 18]);
    }
  };
  const onSelect = (ids: string[]) => {
    // Partial cladding: a wall picked on the drawing (room panel "בחר קיר בשרטוט").
    if (ids[0]?.startsWith("wall:")) {
      setWallPick((w) => ({ wallId: ids[0]!.slice(5), seq: (w?.seq ?? 0) + 1 }));
      setPickingWall(false);
      return;
    }
    const d = ids[0] ? byId.get(ids[0]) : undefined;
    setShowPopover(true);
    selectDetection(d ?? null);
    // Drawing → queue: the clicked item's queue card becomes the active one (keys A/R/E act on it).
    if (d) {
      const it = queueItems.find((i) => i.sheetId === sheetIdNow && i.detectionIds?.includes(d.id));
      setActiveItemId(it?.id ?? null);
    }
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
    setActiveItemId(null);
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
    if ((lineItems.length || lineRooms.length) && lineView.current.zoomed !== key) {
      lineView.current.zoomed = key;
      zoomTo(boundsOf([...lineItems, ...lineRooms.map((r) => ({ bboxMm: polygonBBox(r.polygonMm) }))], 12));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLineId, lineSource, evidence.data, evidenceSheets, row, lineItems, lineRooms]);
  const onSelectClass = (cls: string | null) => {
    setSelectedClass(cls);
    setSelectedId(null);
    if (cls) zoomTo(boundsOf(filtered.filter((d) => d.class === cls), 10));
  };
  const onLasso = (r: LassoResult) => {
    const picked = r.ids.map((id) => byId.get(id)).filter((d): d is Detection => Boolean(d) && !d!.rejected);
    setLassoIds(picked.map((d) => d.id));
    setSelectedId(null);
    setLassoOpen(true);
    setLiveMsg(t("tools.lassoTitle", { count: picked.length }));
  };
  const lassoItems = useMemo(() => lassoIds.map((id) => byId.get(id)).filter((d): d is Detection => Boolean(d)), [lassoIds, byId]);
  void countsByClass;

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


  /* ======================= Sprint 4: queue actions, correction tools, learn, rooms ======================= */
  const versionOf = (sheetId: string) => rowsById.get(sheetId)?.version?.id ?? "v1";
  const floorOfSheet = (sheetId: string) => rowsById.get(sheetId)?.sheet.floors?.[0] ?? null;
  const say = (msg: string) => setLiveMsg(msg);
  /** Pending selection after a queue jump to another sheet (the sheet switch resets the selection). */
  const pendingSelect = useRef<{ sheetId: string; id: string | null } | null>(null);
  useEffect(() => {
    const p = pendingSelect.current;
    if (p && row?.sheet.id === p.sheetId && data) {
      pendingSelect.current = null;
      setSelectedId(p.id);
    }
  }, [row, data]);

  const activate = (it: ReviewQueueItem | null) => {
    setActiveItemId(it?.id ?? null);
    if (!it) return;
    setShowPopover(false);
    setSelectedClass(null);
    setLassoIds([]);
    setLassoOpen(false);
    if (it.kind === "line" && it.lineId) {
      lineView.current = { switched: null, zoomed: null };
      setLineSource("row");
      setSelectedLineId(it.lineId);
      setSelectedId(null);
      return;
    }
    setSelectedLineId(null);
    const selId = it.kind === "detection" ? (it.detectionIds?.[0] ?? null) : null;
    const box = it.kind === "detection" ? padBBox(it.bboxMm, 45, 30) : padBBox(it.bboxMm, 12, 10);
    if (it.sheetId && it.sheetId !== sheetIdNow && rowsById.has(it.sheetId)) {
      // Sheet switch: the new viewer opens at the item (initial view), then the item is selected once loaded.
      pendingSelect.current = { sheetId: it.sheetId, id: selId };
      updateParams((next) => {
        next.set("sheet", it.sheetId);
        next.set("bbox", box.map((n) => n.toFixed(1)).join(","));
        for (const k of ["dom", "floor", "room"]) next.delete(k);
        return next;
      });
      toast({ title: t("boq.switchedSheet", { sheet: sheetName(rowsById.get(it.sheetId)!) }) });
      return;
    }
    setSelectedId(selId);
    zoomTo(box);
  };
  const nextAfter = (id: string, dir: 1 | -1 = 1): ReviewQueueItem | null => {
    const i = queueItems.findIndex((x) => x.id === id);
    if (i < 0) return queueItems[0] ?? null;
    return queueItems[i + dir] ?? (dir === 1 ? queueItems[i - 1] : queueItems[i + 1]) ?? null;
  };
  /**
   * After A / R / E the next item loads automatically (spec): the next one in risk order on the SAME sheet first (no
   * sheet reload between items), then the global next.
   */
  const finish = (it: ReviewQueueItem) => {
    const i = queueItems.findIndex((x) => x.id === it.id);
    const rest = [...queueItems.slice(i + 1), ...queueItems.slice(0, Math.max(0, i))].filter((x) => x.id !== it.id);
    const next = rest.find((x) => x.sheetId === it.sheetId && x.kind !== "line") ?? nextAfter(it.id);
    setDoneIds((cur) => new Set(cur).add(it.id));
    activate(next && next.id !== it.id ? next : null);
  };
  const moveQueue = (dir: 1 | -1) => {
    if (!queueItems.length) return;
    if (!activeItem) return activate(queueItems[0]!);
    const i = queueItems.findIndex((x) => x.id === activeItem.id);
    activate(queueItems[(i + dir + queueItems.length) % queueItems.length]!);
  };
  const membersOf = (it: ReviewQueueItem) => {
    const ex = new Set(exceptions[it.id] ?? []);
    if (it.members?.length) return it.members.filter((m) => !ex.has(m.detectionId));
    return (it.detectionIds ?? []).map((id) => ({ detectionId: id, bboxMm: byId.get(id)?.bboxMm ?? it.bboxMm, score: 0, thumbUrl: null }));
  };
  const detCorrection = (kind: "accept" | "reject" | "reclassify", sheetId: string, m: { detectionId: string; bboxMm: Detection["bboxMm"] }, cls: string | null, extra: Partial<CreateCorrectionRequest> = {}) =>
    baseCorrection(kind, { sheetId, versionId: versionOf(sheetId), anchorMm: bboxCenter(m.bboxMm) }, { detectionId: m.detectionId, class: cls, ...extra });
  const undoAction = () => ({ label: t("queue.undo"), onClick: () => void doUndo() });

  const acceptItem = (it: ReviewQueueItem) => {
    switch (it.kind) {
      case "detection":
      case "cluster": {
        const ms = membersOf(it);
        const n = ms.length;
        void actions.apply(ms.map((m) => detCorrection("accept", it.sheetId, m, it.class ?? null)), {
          label: t("queue.accepted", { count: n }),
          meta: { queueItemId: it.id },
          source: it.kind === "cluster" ? "cluster" : "selection",
        });
        if (it.kind === "cluster") toast({ title: t("queue.accepted", { count: n }), tone: "success", action: undoAction() });
        else say(t("queue.accepted", { count: n }));
        return finish(it);
      }
      case "link_group":
        void actions.apply([baseCorrection("accept", { sheetId: it.sheetId, versionId: it.versionId, anchorMm: bboxCenter(it.bboxMm) }, { linkGroupId: it.linkGroupId ?? null })], {
          label: t("queue.linkAccepted"),
          meta: { queueItemId: it.id },
        });
        say(t("queue.linkAccepted"));
        return finish(it);
      case "room": {
        const r = it.roomId && it.sheetId === sheetIdNow ? rooms.get(it.roomId) : null;
        if (r && it.roomId) {
          putRoom.mutate({ sheetId: it.sheetId, roomId: it.roomId, settings: defaultSettings(r) });
          // The server keeps a room in the queue while it has issues (unnamed / not closed / low confidence);
          // only an accept correction on the room marks it handled, otherwise it comes back after a reload.
          void actions.apply([baseCorrection("accept", { sheetId: it.sheetId, versionId: it.versionId, anchorMm: bboxCenter(it.bboxMm) }, { roomId: it.roomId })], {
            label: t("queue.roomAccepted"),
            meta: { queueItemId: it.id },
          });
          say(t("queue.roomAccepted"));
          return finish(it);
        }
        return activate(it);
      }
      case "line": {
        const l = allLines.find((x) => x.id === it.lineId);
        if (l) advance(l);
        return finish(it);
      }
      case "unmatched_correction":
        return finish(it);
      case "unknown_cluster": {
        const c = clusters.find((x) => x.id === it.clusterId);
        if (c) setPicker({ mode: "resolve", cluster: c });
        else activate(it);
        return;
      }
    }
  };
  const rejectItem = (it: ReviewQueueItem) => {
    switch (it.kind) {
      case "detection":
      case "cluster": {
        const ms = membersOf(it);
        void actions.apply(ms.map((m) => detCorrection("reject", it.sheetId, m, it.class ?? null)), {
          label: t("queue.rejected", { count: ms.length }),
          meta: { queueItemId: it.id },
          source: it.kind === "cluster" ? "cluster" : "selection",
        });
        if (it.kind === "cluster") toast({ title: t("queue.rejected", { count: ms.length }), action: undoAction() });
        else say(t("queue.rejected", { count: ms.length }));
        return finish(it);
      }
      case "link_group":
        void actions.apply([baseCorrection("reject", { sheetId: it.sheetId, versionId: it.versionId, anchorMm: bboxCenter(it.bboxMm) }, { linkGroupId: it.linkGroupId ?? null })], {
          label: t("queue.linkRejected"),
          meta: { queueItemId: it.id },
        });
        say(t("queue.linkRejected"));
        return finish(it);
      case "unknown_cluster": {
        const c = clusters.find((x) => x.id === it.clusterId);
        if (c) void onResolve(c, null, false).then(() => finish(it), () => toast({ title: t("unknown.error"), tone: "error" }));
        return;
      }
      case "unmatched_correction":
        if (it.correctionId) revertCorrection.mutate(it.correctionId);
        return finish(it);
      default:
        return moveQueue(1);
    }
  };
  const editItem = (it: ReviewQueueItem) => {
    if (it.kind === "detection" || it.kind === "cluster") return setPicker({ mode: "queue", item: it });
    if (it.kind === "unknown_cluster") {
      const c = clusters.find((x) => x.id === it.clusterId);
      return c ? setPicker({ mode: "resolve", cluster: c }) : activate(it);
    }
    if (it.kind === "room" && it.roomId) {
      if (it.sheetId !== sheetIdNow) activate(it);
      setRoomSel({ sheetId: it.sheetId, roomId: it.roomId });
      return;
    }
    if (it.kind === "line") {
      const l = allLines.find((x) => x.id === it.lineId);
      if (l && canEditQty(role)) setEditLine(l);
      return;
    }
    if (it.kind === "link_group") setTool("link");
  };

  /** Reclassify detections (picker / lasso / queue) and offer "למד מהתיקון" for the first one. */
  const reclassify = (sheetId: string, ms: { detectionId: string; bboxMm: Detection["bboxMm"] }[], cls: string, meta?: Record<string, unknown>) => {
    if (!ms.length) return;
    const label = t("tools.reclassified", { count: ms.length, name: className(cls) });
    void actions.apply(ms.map((m) => detCorrection("reclassify", sheetId, m, cls)), { label, ...(meta ? { meta } : {}) });
    toast({ title: label, tone: "success", action: undoAction() });
    setRecent((r) => [cls, ...r.filter((x) => x !== cls)].slice(0, 5));
    const first = ms[0]!;
    setLearnOffer({ sheetId, versionId: versionOf(sheetId), bboxMm: first.bboxMm, cls, detectionId: first.detectionId });
  };
  const addAt = (mm: [number, number], cls: string, hitId: string | null) => {
    if (!row?.version) return;
    const room = roomAt(rooms.values(), mm);
    const req = baseCorrection(
      "add",
      { sheetId: row.sheet.id, versionId: row.version.id, anchorMm: { x: mm[0], y: mm[1] } },
      { class: cls, roomId: room?.id ?? null, floor: room?.floor ?? floorOfSheet(row.sheet.id), geometry: { type: "point", mm: [{ x: mm[0], y: mm[1] }] } },
    );
    const label = t("tools.added", { name: className(cls) });
    void actions.apply([req], { label });
    say(label);
    setRecent((r) => [cls, ...r.filter((x) => x !== cls)].slice(0, 5));
    const hit = hitId ? byId.get(hitId) : null;
    setLearnOffer({
      sheetId: row.sheet.id,
      versionId: row.version.id,
      bboxMm: hit?.bboxMm ?? { x: mm[0] - 2.5, y: mm[1] - 2.5, w: 5, h: 5 },
      cls,
      detectionId: hit?.id ?? null,
    });
  };
  const onPointTool = (e: PointToolEvent) => {
    if (e.tool === "add") {
      if (addClass) addAt(e.mm, addClass, e.hitId);
      else setPicker({ mode: "add", mm: e.mm });
      return;
    }
    const d = e.hitId ? byId.get(e.hitId) : null;
    if (!d || !row) return;
    const label = t("tools.removed", { name: className(d.class) });
    void actions.apply([detCorrection("reject", row.sheet.id, { detectionId: d.id, bboxMm: d.bboxMm }, d.class)], { label });
    say(label);
  };
  const onMove = (r: MoveResult) => {
    const d = byId.get(r.id);
    if (!d || !row) return;
    const label = t("tools.moved", { name: className(d.class) });
    void actions.apply(
      [
        baseCorrection(
          "move",
          { sheetId: row.sheet.id, versionId: versionOf(row.sheet.id), anchorMm: d.centerMm },
          { detectionId: d.id, class: d.class, geometry: { type: "point", mm: [{ x: r.toMm[0], y: r.toMm[1] }] } },
        ),
      ],
      { label },
    );
    say(label);
  };
  const onLink = (r: LinkResult) => {
    const a = byId.get(r.fromId);
    const b = byId.get(r.toId);
    if (!a || !b || !row) return;
    const isSw = (d: Detection) => d.class.startsWith("switch");
    const sw = isSw(a) ? a : isSw(b) ? b : null;
    const pt = sw === a ? b : a;
    if (!sw || isSw(pt)) return toast({ title: t("tools.linkNeedsSwitch"), tone: "error" });
    const group = (links?.groups ?? []).find((g) => g.switchIds.includes(sw.id) && g.luminaireIds.includes(pt.id));
    const kind = group ? "unlink" : "link";
    const label = t(group ? "tools.unlinked" : "tools.linked", { from: className(sw.class), to: className(pt.class) });
    void actions.apply(
      [baseCorrection(kind, { sheetId: row.sheet.id, versionId: versionOf(row.sheet.id), anchorMm: sw.centerMm }, { switchIds: [sw.id], pointIds: [pt.id], linkGroupId: group?.id ?? null })],
      { label },
    );
    toast({ title: label, tone: "success", action: undoAction() });
    setSelectedId(sw.id); // shows the switch's (new) group on the drawing
  };
  const onCount = (r: CountResult) => {
    if (!row?.version) return;
    setAssign({ kind: "count", qty: r.pointsMm.length, unit: "יחידה", pointsMm: r.pointsMm, sheetId: row.sheet.id, versionId: row.version.id });
  };
  const onArea = (r: AreaResult) => {
    if (!row?.version) return;
    if (r.areaM2 === null) return toast({ title: t("tools.noScale"), tone: "error" });
    setAssign({ kind: "area", qty: Math.round(r.areaM2 * 100) / 100, unit: 'מ"ר', pointsMm: r.polygonMm, sheetId: row.sheet.id, versionId: row.version.id });
  };
  const onLength = (r: LengthResult) => {
    if (!row?.version) return;
    if (r.lengthM === null) return toast({ title: t("tools.noScale"), tone: "error" });
    setAssign({ kind: "length", qty: Math.round(r.lengthM * 100) / 100, unit: 'מ"א', pointsMm: r.pathMm, sheetId: row.sheet.id, versionId: row.version.id });
  };
  const saveAssign = (code: string) => {
    const a = assign;
    setAssign(null);
    if (!a) return;
    const first = a.pointsMm[0] ?? [0, 0];
    const req = baseCorrection(
      a.kind === "count" ? "count" : "measure",
      { sheetId: a.sheetId, versionId: a.versionId, anchorMm: { x: first[0], y: first[1] } },
      {
        itemCode: code,
        quantity: a.qty,
        unit: a.kind === "count" ? "unit" : a.kind === "area" ? "m2" : "m",
        floor: floorOfSheet(a.sheetId),
        geometry: { type: a.kind === "count" ? "point" : a.kind === "area" ? "polygon" : "polyline", mm: a.pointsMm.map(([x, y]) => ({ x, y })) },
      },
    );
    const label = a.kind === "count" ? t("tools.counted", { count: a.qty, code }) : t("tools.measured", { qty: a.qty, unit: a.unit, code });
    void actions.apply([req], { label });
    toast({ title: label, tone: "success", action: undoAction() });
    setTool("select");
  };
  const onCalibrate = (r: CalibrationResult) => {
    if (!row) return;
    const den = Math.max(1, Math.min(10_000, Math.round(r.denominator)));
    setScaleOverride((m) => ({ ...m, [row.sheet.id]: den }));
    const n = manual.filter((m) => m.kind !== "count").length;
    api
      .confirmSheet(projectId, row.sheet.id, { discipline: row.sheet.discipline ?? "other", floors: row.sheet.floors ?? [], scaleDenominator: den })
      .then(() => toast({ title: t("tools.calibrated", { scale: `1:${den}`, count: n }), tone: "success" }))
      .catch(() => toast({ title: t("tools.calibrateError"), tone: "error" }));
    setTool("select");
  };
  const lassoAccept = () => {
    if (!row || !lassoItems.length) return;
    const label = t("queue.accepted", { count: lassoItems.length });
    void actions.apply(lassoItems.map((d) => detCorrection("accept", row.sheet.id, { detectionId: d.id, bboxMm: d.bboxMm }, d.class)), { label, source: "lasso" });
    toast({ title: label, tone: "success", action: undoAction() });
    setLassoOpen(false);
    setLassoIds([]);
  };
  const lassoReject = () => {
    if (!row || !lassoItems.length) return;
    const label = t("queue.rejected", { count: lassoItems.length });
    void actions.apply(lassoItems.map((d) => detCorrection("reject", row.sheet.id, { detectionId: d.id, bboxMm: d.bboxMm }, d.class)), { label, source: "lasso" });
    toast({ title: label, action: undoAction() });
    setLassoOpen(false);
    setLassoIds([]);
  };
  const onPick = (cls: string) => {
    const p = picker;
    setPicker(null);
    if (!p) return;
    if (p.mode === "queue") {
      reclassify(p.item.sheetId, membersOf(p.item), cls, { queueItemId: p.item.id });
      return finish(p.item);
    }
    if (p.mode === "detections" && row) {
      const ms = p.ids.map((id) => byId.get(id)).filter((d): d is Detection => Boolean(d)).map((d) => ({ detectionId: d.id, bboxMm: d.bboxMm }));
      reclassify(row.sheet.id, ms, cls);
      setLassoOpen(false);
      setLassoIds([]);
      return;
    }
    if (p.mode === "add") {
      setAddClass(cls);
      if (Number.isFinite(p.mm[0])) addAt(p.mm, cls, null);
      return;
    }
    if (p.mode === "resolve") {
      const it = queueItems.find((i) => i.clusterId === p.cluster.id);
      void onResolve(p.cluster, cls === "__ignore" ? null : cls, true).then(() => it && finish(it));
    }
  };

  /* learn from correction */
  const startLearn = () => {
    const ex = learnOffer;
    if (!ex) return;
    setLearnOffer(null);
    setLearnCls(ex.cls);
    setLearnStart(null);
    setLearnSel([]);
    findSimilar.mutate(
      { exemplar: { sheetId: ex.sheetId, versionId: ex.versionId, bboxMm: ex.bboxMm, class: ex.cls, detectionId: ex.detectionId }, scope: "project" },
      { onSuccess: (res) => setLearnStart(res), onError: () => toast({ title: t("learn.failed"), tone: "error" }) },
    );
  };
  const closeLearn = () => {
    setLearnCls(null);
    setLearnStart(null);
    setLearnSel([]);
  };
  const applyLearn = (sel: SimilarCandidate[]) => {
    const cls = learnCls;
    if (!cls) return;
    const reqs = sel.map((c) =>
      c.alreadyDetected
        ? baseCorrection(c.currentClass === cls ? "accept" : "reclassify", { sheetId: c.sheetId, versionId: c.versionId, anchorMm: c.centerMm }, {
            detectionId: c.alreadyDetected,
            class: cls,
            reason: "learned",
          })
        : baseCorrection("add", { sheetId: c.sheetId, versionId: c.versionId, anchorMm: c.centerMm }, { class: cls, reason: "learned", geometry: { type: "point", mm: [c.centerMm] } }),
    );
    const label = t("learn.applied", { count: reqs.length, name: className(cls) });
    void actions.apply(reqs, { label, batchId: newId("learn"), source: "similar", similarSearchId: learnStart?.id ?? null });
    toast({ title: label, tone: "success", action: undoAction() });
    closeLearn();
  };

  /* undo / redo */
  const doUndo = async () => {
    const step = await actions.undo();
    if (!step) return toast({ title: t("queue.nothingToUndo") });
    const qid = step.meta?.queueItemId as string | undefined;
    if (qid) {
      setDoneIds((cur) => {
        const n = new Set(cur);
        n.delete(qid);
        return n;
      });
      setActiveItemId(qid);
    }
    toast({ title: t("queue.undone", { label: step.label }) });
  };
  const doRedo = async () => {
    const step = await actions.redo();
    if (!step) return toast({ title: t("queue.nothingToRedo") });
    const qid = step.meta?.queueItemId as string | undefined;
    if (qid) setDoneIds((cur) => new Set(cur).add(qid));
    toast({ title: t("queue.redone", { label: step.label }) });
  };

  /* room panel */
  const onBackgroundClick = (mm: [number, number]) => {
    // Picking a wall for partial cladding: the nearest wall of the open room within 4 mm (paper), no GPU picking needed.
    if (pickingWall && selRoom) {
      const w = nearestWall(selRoomWalls, mm, 4);
      if (w) {
        setWallPick((x) => ({ wallId: w.id, seq: (x?.seq ?? 0) + 1 }));
        setPickingWall(false);
      }
      return;
    }
    if (!layers.rooms) return;
    const r = roomAt(rooms.values(), mm);
    if (r && row) setRoomSel({ sheetId: row.sheet.id, roomId: r.id });
  };
  const saveRoom = async (settings: RoomSettings) => {
    if (!roomSel) return;
    try {
      await putRoom.mutateAsync({ sheetId: roomSel.sheetId, roomId: roomSel.roomId, settings });
      toast({ title: t("room.saved"), tone: "success" });
      setDoneIds((cur) => new Set(cur).add(`room:${roomSel.sheetId}:${roomSel.roomId}`));
    } catch {
      toast({ title: t("room.saveError"), tone: "error" });
    }
  };
  useEffect(() => {
    if (!roomSel) {
      setPickingWall(false);
      setRoomDraft(null);
    }
  }, [roomSel]);

  /* entry: the highest-risk item of the current sheet is selected and the drawing focuses on it (spec flow 6) */
  const autoActivated = useRef(false);
  useEffect(() => {
    if (autoActivated.current || !queueQ.data || !row || !data || selectedLineId || activeItemId) return;
    autoActivated.current = true;
    const first = queueItems.find((i) => i.sheetId === row.sheet.id && i.kind !== "line");
    if (first) activate(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueQ.data, row, data]);

  /* speed protocol (mock/dev): keydown → next painted frame, per queue action */
  const keyAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const t0 = keyAt.current;
    if (t0 === null || typeof window === "undefined" || !window.__kamutanQueue) return;
    keyAt.current = null;
    requestAnimationFrame(() => {
      const m = window.__kamutanQueue!;
      m.latencies.push(performance.now() - t0);
      m.actions++;
    });
  }, [activeItemId, doneIds]);
  useEffect(() => {
    if (!import.meta.env.DEV && import.meta.env.VITE_USE_MOCKS !== "true") return;
    window.__kamutanQueue ??= { latencies: [], actions: 0, remaining: () => 0 };
  }, []);
  const remainingRef = useRef(0);
  remainingRef.current = queueItems.length;
  useEffect(() => {
    if (window.__kamutanQueue) window.__kamutanQueue.remaining = () => remainingRef.current;
  }, []);

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
  /**
   * Keyboard (spec §טבלת קיצורי מקלדת) by event.code — the physical key, so it works on a Hebrew layout too.
   * Target precedence: lasso selection > selected BOQ row (no active queue item) > active queue item > clicked item.
   */
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [role='menu'], [contenteditable='true']")) return;
    if (document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']")) return;
    const code = e.code;
    const shift = e.shiftKey;
    if (e.ctrlKey || e.metaKey) {
      if (code === "KeyZ") {
        e.preventDefault();
        void (shift ? doRedo() : doUndo());
      }
      return;
    }
    const lineMode = Boolean(selectedLine) && !activeItem;
    const lasso = lassoOpen && lassoItems.length > 0;
    const handled = (() => {
      if (code === "Slash" && shift) return setHelpOpen(true), true;
      if (code === "Escape") {
        if (pickingWall) return setPickingWall(false), true;
        if (lassoOpen) return setLassoOpen(false), setLassoIds([]), true;
        if (tool !== "select") return setTool("select"), true;
        if (selectedId) return setSelectedId(null), true;
        return false;
      }
      if (code === "KeyZ") return void (shift ? doRedo() : doUndo()), true;
      if (code === "KeyL" && shift) return learnOffer ? (startLearn(), true) : false;
      if ((code === "Delete" || code === "Backspace") && (selectedId || lasso)) {
        if (lasso) return lassoReject(), true;
        const d = selectedId ? byId.get(selectedId) : null;
        if (d && row) {
          const label = t("tools.removed", { name: className(d.class) });
          void actions.apply([detCorrection("reject", row.sheet.id, { detectionId: d.id, bboxMm: d.bboxMm }, d.class)], { label });
          say(label);
          setSelectedId(null);
        }
        return true;
      }
      const toolHit = toolForKey(REVIEW_TOOLS, e) ?? (code === "NumpadAdd" ? "add" : null);
      if (toolHit) {
        // "+" asks for the class the first time; pressed again while adding, it changes the class.
        if (toolHit === "add" && (tool === "add" || !addClass)) setPicker({ mode: "add", mm: [NaN, NaN] });
        setTool(toolHit);
        return true;
      }
      if (code === "BracketRight") return step(1), true;
      if (code === "BracketLeft") return step(-1), true;
      if (code === "KeyA" && !shift) {
        keyAt.current = performance.now();
        if (lasso) return lassoAccept(), true;
        if (lineMode) return advance(selectedLine!), true;
        if (activeItem) return acceptItem(activeItem), true;
        if (selected && row) {
          void actions.apply([detCorrection("accept", row.sheet.id, { detectionId: selected.id, bboxMm: selected.bboxMm }, selected.class)], { label: t("queue.accepted", { count: 1 }) });
          return true;
        }
        return false;
      }
      if (code === "KeyR" && !shift) {
        keyAt.current = performance.now();
        if (lasso) return lassoReject(), true;
        if (activeItem) return rejectItem(activeItem), true;
        if (selected && row) {
          void actions.apply([detCorrection("reject", row.sheet.id, { detectionId: selected.id, bboxMm: selected.bboxMm }, selected.class)], { label: t("queue.rejected", { count: 1 }) });
          return true;
        }
        return false;
      }
      if (code === "KeyE" && !shift) {
        if (lasso) return setPicker({ mode: "detections", ids: lassoIds }), true;
        if (lineMode) return canEditQty(role) ? (setEditLine(selectedLine), true) : false;
        if (activeItem) return editItem(activeItem), true;
        if (selected) return setPicker({ mode: "detections", ids: [selected.id] }), true;
        return false;
      }
      if (code === "KeyN" || code === "KeyJ") {
        keyAt.current = performance.now();
        if (code === "KeyN" && !shift && lineMode && tab === "boq" && allLines.length) return goNext(), true;
        return moveQueue(1), true;
      }
      if ((code === "KeyP" || code === "KeyK") && !shift) {
        keyAt.current = performance.now();
        return moveQueue(-1), true;
      }
      if (code === "KeyF" && !shift) {
        const b = activeItem && activeItem.sheetId === sheetIdNow ? activeItem.bboxMm : selected?.bboxMm;
        if (b) zoomTo(padBBox(b));
        return Boolean(b);
      }
      return false;
    })();
    if (handled) e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onResolve = async (c: UnknownCluster, cls: string | null, remember: boolean) => {
    if (!row?.version) return;
    const n = clusterMembers.get(c.id)?.length ?? c.count;
    await resolve.mutateAsync({ clusterId: c.id, sheetId: row.sheet.id, versionId: row.version.id, cls, remember });
    // The "מה זה?" card leaves the queue at once; the ranked queue is re-read (the answer changes items and lines).
    const qid = queueItems.find((i) => i.kind === "unknown_cluster" && i.clusterId === c.id)?.id;
    if (qid) setDoneIds((cur) => new Set(cur).add(qid));
    void qc.invalidateQueries({ queryKey: ["review-queue", projectId] });
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
  const popover = useMemo(
    () =>
      selected && showPopover
        ? {
            anchorMm: [selected.centerMm.x, selected.centerMm.y] as const,
            label: t("understanding.details"),
            content: <DetectionDetails d={selected} ctx={ctxOf(selected)} onClose={() => setSelectedId(null)} />,
          }
        : null,
    [selected, showPopover, ctxOf, t],
  );

  /** BOQ items for a manual quantity: same unit first (יחידה for counts, מ"ר / מ"א for measures). */
  const assignOptions: PickerOption[] = useMemo(() => {
    const unitOk = (u: string) =>
      assign?.kind === "count" ? !/מ"ר|מ"א|מ״ר|מ״א/.test(u) : assign?.kind === "area" ? /מ"ר|מ״ר/.test(u) : /מ"א|מ״א/.test(u);
    const items = (library.data?.items ?? []).filter((i) => i.active);
    const sorted = [...items].sort((a, b) => Number(unitOk(b.unit)) - Number(unitOk(a.unit)) || a.code.localeCompare(b.code, undefined, { numeric: true }));
    return sorted.map((i) => ({ value: i.code, label: `${i.code} · ${i.description}`, hint: i.unit, group: unitOk(i.unit) ? t("boq.columns.unit") + ": " + i.unit : t("tools.pickerAll") }));
  }, [library.data, assign, t]);

  /* ---------- stable props for the memoised panes (keyboard loop < 100 ms) ---------- */
  const fn = useLatestFns({
    setTab,
    openHistory: (l: BoqLine) => setHistoryLine(l),
    onBuild: () => void onBuild(),
    selectClassFromCounts: (c: string | null) => {
      setSelectedLineId(null);
      onSelectClass(c);
    },
    legendLabel: (id: string | null) => (id ? (legendEntries.get(id)?.label ?? null) : null),
    legendThumb: (id: string | null) => (id ? (thumbs[id] ?? null) : null),
    clearOverlayFilters: () => setFilters(EMPTY_FILTERS),
    clearAllFilters: () => {
      setFilters(EMPTY_FILTERS);
      setStatusFilter("all");
    },
    sheetLabel: (id: string) => {
      const r = ready.find((x) => x.sheet.id === id);
      return r ? sheetName(r) : id;
    },
    pick: (id: string) => pick(id),
    onSelect,
    onLasso,
    onPointTool,
    onMove,
    onLink,
    onCount,
    onArea,
    onLength,
    onBackgroundClick,
    onCalibrate,
    onToolChange: (x: ViewerTool) => {
      setTool(x);
      if (x === "add" && !addClass) setPicker({ mode: "add", mm: [NaN, NaN] });
    },
    undo: () => void doUndo(),
    redo: () => void doRedo(),
    activate,
    acceptItem,
    rejectItem,
    editItem,
    jumpDetection: (d: Detection) => selectDetection(d, true),
    toggleException: (itemId: string, detId: string) =>
      setExceptions((cur) => {
        const list = cur[itemId] ?? [];
        return { ...cur, [itemId]: list.includes(detId) ? list.filter((x) => x !== detId) : [...list, detId] };
      }),
    onResolve,
    sheetBadge: (r: SheetRow) => {
      if (selectedLineId && evidence.data) {
        const n = evidenceSheets.get(r.sheet.id) ?? 0;
        return n ? t(selectedLine && isCompositeLine(selectedLine) ? "boq.sheetGroups" : "boq.sheetEvidence", { count: n }) : null;
      }
      const s = r.version?.stats?.detections;
      return s && s.red + s.unknown ? t("review.toReview", { count: s.red + s.unknown }) : null;
    },
  });
  const renderReceiptExtra = useCallback(
    (l: BoqLine) => <ReceiptGroups projectId={projectId} buildId={buildId} lineId={l.id} sheetLabel={fn.sheetLabel} />,
    [projectId, buildId, fn],
  );
  const countsEl = useMemo(
    () => (
      <CountsPanel
        counts={counts}
        selectedClass={selectedClass}
        onSelectClass={fn.selectClassFromCounts}
        legendLabel={fn.legendLabel}
        legendThumb={fn.legendThumb}
        loading={overlay.isLoading && Boolean(row)}
        error={overlay.isError}
        filtered={isFiltered(filters)}
        onClearFilters={fn.clearOverlayFilters}
      />
    ),
    [counts, selectedClass, fn, overlay.isLoading, overlay.isError, row, filters],
  );
  const viewerSelectedIds = useMemo(() => (selectedId ? [selectedId] : lassoIds), [selectedId, lassoIds]);
  const unknownCtx = useMemo(() => ({ detById: byId, rooms, thumbs, clusters }), [byId, rooms, thumbs, clusters]);
  const queueHandlers = useMemo(
    () => ({
      onActivate: fn.activate,
      onAccept: fn.acceptItem,
      onReject: fn.rejectItem,
      onEdit: fn.editItem,
      onJumpDetection: fn.jumpDetection,
      onHoverMember: setHoverMember,
      onToggleException: fn.toggleException,
      onResolve: fn.onResolve,
    }),
    [fn],
  );

  const toolNote = useMemo(
    () =>
      tool === "add" && addClass ? (
        <button
          type="button"
          onClick={() => setPicker({ mode: "add", mm: [NaN, NaN] })}
          className="inline-flex h-7 items-center gap-1 rounded-sm border border-manual/40 bg-manual/[0.07] px-2 text-meta text-foreground hover:bg-manual/15"
        >
          {t("viewer.add")}: <span className="font-medium">{className(addClass)}</span>
        </button>
      ) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, addClass, t],
  );
  const overlayExtra = useMemo(
    () => (
      <>
        {learnOffer && !learnCls ? (
          <div className="pointer-events-none absolute inset-x-0 top-12 z-20 flex justify-center">
            <div
              dir="rtl"
              role="status"
              data-learn-offer
              className="pointer-events-auto flex items-center gap-2 rounded-lg border border-manual/40 bg-surface px-3 py-2 text-dense shadow-float"
            >
              <Sparkles className="size-4 shrink-0 text-manual" aria-hidden />
              <span className="text-foreground">{t("learn.banner")}</span>
              <Button size="sm" onClick={startLearn} aria-keyshortcuts="Shift+L">
                {t("learn.find")}
                <Kbd className="border-primary-foreground/40 bg-transparent text-primary-foreground">⇧L</Kbd>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLearnOffer(null)}>
                {t("learn.dismiss")}
              </Button>
            </div>
          </div>
        ) : null}
        {learnCls ? (
          <LearnPanel
            projectId={projectId}
            search={learnQ.data ?? learnStart}
            cls={learnCls}
            rows={rowsById}
            loading={findSimilar.isPending}
            failed={findSimilar.isError || learnQ.data?.status === "failed"}
            onSelectionChange={setLearnSel}
            onApply={(sel) => applyLearn(sel)}
            onCancel={closeLearn}
          />
        ) : null}
        {lassoOpen && tool === "lasso" ? (
          <LassoCard
            items={lassoItems}
            onAccept={lassoAccept}
            onReject={lassoReject}
            onAssign={() => setPicker({ mode: "detections", ids: lassoIds })}
            onCount={() =>
              row?.version &&
              setAssign({
                kind: "count",
                qty: lassoItems.length,
                unit: "יחידה",
                pointsMm: lassoItems.map((d) => [d.centerMm.x, d.centerMm.y]),
                sheetId: row.sheet.id,
                versionId: row.version.id,
              })
            }
            onClose={() => {
              setLassoOpen(false);
              setLassoIds([]);
            }}
          />
        ) : null}
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      learnOffer,
      learnCls,
      learnQ.data,
      learnStart,
      findSimilar.isPending,
      findSimilar.isError,
      rowsById,
      projectId,
      lassoOpen,
      tool,
      lassoItems,
      lassoIds,
      row,
      t,
    ],
  );
  const viewerCallbacks = useMemo(
    () => ({
      onPointTool: fn.onPointTool,
      onMove: fn.onMove,
      onLink: fn.onLink,
      onCount: fn.onCount,
      onArea: fn.onArea,
      onLength: fn.onLength,
      onBackgroundClick: fn.onBackgroundClick,
      snapPoints,
      scaleDenominator: scale,
      overlayExtra,
    }),
    [fn, snapPoints, scale, overlayExtra],
  );

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
            {locked ? (
              <>
                <li className="text-muted-foreground">{t("review.sheetAnalysis")}</li>
                <li aria-hidden className="text-muted-foreground">‹</li>
                <li aria-current="page" className="min-w-0 truncate font-medium text-foreground">
                  <bdi>{row ? sheetName(row) : "…"}</bdi>
                </li>
              </>
            ) : (
              <li aria-current="page" className="font-medium text-foreground">{t("review.title")}</li>
            )}
          </ol>
        </nav>
        <div className="flex flex-1 items-center justify-end gap-3">
          <button
            type="button"
            onClick={notYet}
            className="hidden h-8 w-48 items-center gap-2 rounded border border-input bg-surface-sunken px-2.5 text-dense text-muted-foreground hover:border-foreground/30"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="flex-1 text-start">{t("review.search")}</span>
            <Kbd>⌘K</Kbd>
          </button>
          <CalibrationBadge calibration={calibration} capped={capped} greenThreshold={greenThreshold} />
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
          <Button size="sm" variant="secondary" onClick={() => setShareOpen(true)}>
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
          onTab={fn.setTab}
          counts={countsEl}
          state={state}
          build={build.data ?? null}
          onBuild={fn.onBuild}
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
          renderReceiptExtra={renderReceiptExtra}
          flashLineId={flashLineId}
          split={split}
          onSplit={setSplit}
          showOrder={showOrder}
          onShowOrder={setShowOrder}
          statusFilter={statusFilter}
          onStatusFilter={setStatusFilter}
          filtered={isFiltered(filters) || statusFilter !== "all"}
          onClearFilters={fn.clearAllFilters}
          onHistory={fn.openHistory}
          calibrationBadge={panelBadge}
        />
        <section id="drawing-panel" tabIndex={-1} aria-label={t("review.drawingPanel")} className="flex min-h-0 flex-col border-x border-border">
          <ReviewDrawing
            projectId={projectId}
            rows={ready}
            row={row}
            locked={locked}
            loading={sheets.isLoading}
            onPick={fn.pick}
            overlays={features}
            selectedIds={viewerSelectedIds}
            focusIds={focusIds}
            onSelect={fn.onSelect}
            onLasso={fn.onLasso}
            popover={popover}
            renderTooltip={renderTooltip}
            zoomRequest={zoomRequest}
            initialViewMm={bbox}
            lifecycles={lifecycles}
            onLifecycles={setLifecycles}
            layers={layers}
            onLayers={setLayers}
            tool={tool}
            onToolChange={fn.onToolChange}
            onCalibrate={fn.onCalibrate}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            onUndo={fn.undo}
            onRedo={fn.redo}
            toolNote={toolNote}
            callbacks={viewerCallbacks}
            sheetBadge={fn.sheetBadge}
          />
        </section>
        {selRoom && roomSel ? (
          <section id="queue-panel" tabIndex={-1} aria-label={t("room.title")} className="flex min-h-0 flex-col bg-surface">
            <RoomPanel
              room={selRoom}
              walls={selRoomWalls}
              saved={savedRoom}
              wallPick={wallPick}
              pickingWall={pickingWall}
              onPickingWall={(on) => {
                setPickingWall(on);
                if (on) setTool("select");
              }}
              onDraftChange={setRoomDraft}
              onSave={saveRoom}
              onClose={() => setRoomSel(null)}
              saving={putRoom.isPending}
            />
          </section>
        ) : (
          <ReviewQueuePanel
            projectId={projectId}
            items={queueItems}
            doneCount={doneIds.size}
            activeId={activeItemId}
            rows={rowsById}
            currentSheetId={sheetIdNow || null}
            unknown={unknownCtx}
            exceptions={exceptions}
            handlers={queueHandlers}
            loading={queueQ.isLoading}
            error={queueQ.isError}
            verifiedPct={pct}
          />
        )}
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
          ) : selectedClass ? (
            t("understanding.selectedClass", { name: className(selectedClass, t("understanding.unknownClass")), count: classItems.length })
          ) : lassoIds.length ? (
            t("viewer.lassoResult", { count: lassoIds.length })
          ) : activeItem ? (
            `${t(`queue.kind.${activeItem.kind}`)} · ${activeItem.class ? className(activeItem.class) : (activeItem.title ?? activeItem.itemCode ?? "")}${activeItem.detectionIds && activeItem.detectionIds.length > 1 ? ` · ${t("boq.items", { count: activeItem.detectionIds.length })}` : ""}`
          ) : (
            <span className="font-normal text-muted-foreground">{t("understanding.nothingSelected")}</span>
          )}
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
        {selectedLine ? (
          <Button size="sm" variant="ghost" onClick={() => setHistoryLine(selectedLine)}>
            <History aria-hidden />
            {t("history.open")}
          </Button>
        ) : null}
        <span className="sr-only" aria-live="polite" data-testid="live-msg">
          {liveMsg}
        </span>
        <div className="ms-auto flex items-center gap-1.5">
          {lassoOpen && lassoItems.length ? (
            <>
              <Button size="sm" onClick={lassoAccept} aria-keyshortcuts="A">
                <Kbd className="border-primary-foreground/40 bg-transparent text-primary-foreground">A</Kbd>
                {t("queue.acceptAll")}
              </Button>
              <Button size="sm" variant="secondary" onClick={lassoReject} aria-keyshortcuts="R">
                <Kbd>R</Kbd>
                {t("queue.rejectAll")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setPicker({ mode: "detections", ids: lassoIds })} aria-keyshortcuts="E">
                <Kbd>E</Kbd>
                {t("tools.lassoAssign")}
              </Button>
            </>
          ) : activeItem && !selectedLine ? (
            <>
              <Button size="sm" onClick={() => acceptItem(activeItem)} aria-keyshortcuts="A">
                <Kbd className="border-primary-foreground/40 bg-transparent text-primary-foreground">A</Kbd>
                {activeItem.kind === "cluster" ? t("queue.acceptAll") : t("review.approve")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => rejectItem(activeItem)} aria-keyshortcuts="R">
                <Kbd>R</Kbd>
                {activeItem.kind === "cluster" ? t("queue.rejectAll") : t("review.reject")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => editItem(activeItem)} aria-keyshortcuts="E">
                <Kbd>E</Kbd>
                {activeItem.kind === "room" ? t("queue.openRoom") : t("queue.edit")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => moveQueue(1)} aria-keyshortcuts="N">
                <Kbd>N</Kbd>
                {t("review.next")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setHelpOpen(true)} aria-keyshortcuts="Shift+Slash">
                <Kbd>?</Kbd>
                {t("review.shortcuts")}
              </Button>
            </>
          ) : tab === "boq" && buildId ? (
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
                    <Kbd className="border-primary-foreground/40 bg-transparent text-primary-foreground">A</Kbd>{" "}
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
              <Button key={a.k} size="sm" variant={a.primary ? "primary" : "secondary"} disabled aria-keyshortcuts={a.k}>
                <Kbd className={a.primary ? "border-primary-foreground/40 bg-transparent text-primary-foreground" : undefined}>{a.k}</Kbd>
                {a.label}
              </Button>
            ))
          )}
        </div>
      </footer>

      <OptionPicker
        open={picker !== null}
        onOpenChange={(o) => !o && setPicker(null)}
        title={picker?.mode === "add" ? t("tools.pickerTitleAdd") : picker?.mode === "resolve" ? t("unknown.chooseLabel") : t("tools.pickerTitle")}
        searchLabel={t("tools.pickerSearch")}
        options={[
          ...classOptions(t, row?.sheet.discipline ?? null),
          ...(picker?.mode === "resolve" ? [{ value: "__ignore", label: t("unknown.notRelevant"), group: "—" }] : []),
        ]}
        recent={recent}
        onPick={onPick}
      />
      <OptionPicker
        open={assign !== null}
        onOpenChange={(o) => !o && setAssign(null)}
        title={
          assign?.kind === "count"
            ? t("tools.assignTitleCount", { count: assign.qty })
            : assign?.kind === "area"
              ? t("tools.assignTitleArea", { qty: assign.qty })
              : t("tools.assignTitleLength", { qty: assign?.qty ?? 0 })
        }
        description={t("tools.assignBody")}
        searchLabel={t("tools.assignSearch")}
        options={assignOptions}
        onPick={saveAssign}
      />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <OverrideDialog
        line={editLine}
        open={editLine !== null}
        onOpenChange={(o) => !o && setEditLine(null)}
        onSave={saveOverride}
        saving={patchLine.isPending}
      />
      <LineHistoryDialog projectId={projectId} line={historyLine} open={historyLine !== null} onOpenChange={(o) => !o && setHistoryLine(null)} />
      <ShareDialog projectId={projectId} open={shareOpen} onOpenChange={setShareOpen} canManage={role === "admin" || role === "editor"} sheetNames={sheetNames} />
      <ExportDialog
        projectId={projectId}
        sheets={ready}
        canMarkedPdf={role === "admin" || role === "editor"}
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
