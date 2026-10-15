import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Crosshair, Settings2, X } from "lucide-react";
import type { Detection, ReviewQueueItem, Room, SheetRow, UnknownCluster } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { ConfidenceBadge, ConfidenceShape } from "@/components/ConfidenceBadge";
import { ReasonChip } from "@/components/ReasonChip";
import { Kbd } from "@/components/Kbd";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { sheetName } from "@/features/sheets/model";
import { uiLevel } from "@/features/understanding/model";
import { ClassSelect } from "@/features/understanding/ClassSelect";
import { className } from "@/features/understanding/taxonomy";
import { estimateMinutes } from "./queueModel";
import { TileCrop } from "./TileCrop";

const IGNORE = "__ignore";
const THUMBS = 6;
const THUMBS_EXPANDED = 60;

/** Stable callbacks (one object for the whole session → memoised cards skip re-rendering). */
export interface QueueHandlers {
  onActivate: (item: ReviewQueueItem) => void;
  onAccept: (item: ReviewQueueItem) => void;
  onReject: (item: ReviewQueueItem) => void;
  onEdit: (item: ReviewQueueItem) => void;
  onJumpDetection: (d: Detection) => void;
  onHoverMember: (id: string | null) => void;
  onToggleException: (itemId: string, detectionId: string) => void;
  onResolve: (cluster: UnknownCluster, cls: string | null, remember: boolean) => Promise<void>;
}
/** Current-sheet context only "מה זה?" cards need (locations, names, crops). */
export interface UnknownContext {
  detById: ReadonlyMap<string, Detection>;
  rooms: ReadonlyMap<string, Room>;
  thumbs: Record<string, string>;
  clusters: readonly UnknownCluster[];
}

export interface ReviewQueuePanelProps {
  projectId: string;
  items: ReviewQueueItem[];
  /** Items handled this session (for the progress bar). */
  doneCount: number;
  activeId: string | null;
  rows: ReadonlyMap<string, SheetRow>;
  currentSheetId: string | null;
  unknown: UnknownContext;
  exceptions: Readonly<Record<string, readonly string[]>>;
  handlers: QueueHandlers;
  loading: boolean;
  error: boolean;
  verifiedPct: number;
}

const impactOf = (risk: number) => (risk >= 3 ? "high" : risk >= 1 ? "mid" : "low");

/**
 * Left pane (spec §תור בדיקה): every kind of open item ranked by risk (impact × uncertainty), cluster cards with
 * thumbnails and "אשר הכל / דחה הכל", "מה זה?" for unknown symbols, rooms, link groups, unmatched corrections and
 * lines. The active item is selected on the drawing; A/R/E/N/P act on it from the keyboard (see ReviewPage).
 */
export function ReviewQueuePanel(p: ReviewQueuePanelProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLOListElement>(null);
  const remaining = p.items.length;
  const total = remaining + p.doneCount;
  const minutes = estimateMinutes(p.items);
  useEffect(() => {
    if (!p.activeId) return;
    listRef.current?.querySelector(`[data-queue-item="${CSS.escape(p.activeId)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [p.activeId]);

  return (
    <section id="queue-panel" tabIndex={-1} aria-label={t("review.queuePanel")} className="flex min-h-0 flex-col bg-surface">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-panel text-foreground">{t("review.queuePanel")}</h2>
          <span className="text-meta text-muted-foreground" aria-live="polite" data-testid="queue-remaining">
            {t("queue.remaining", { count: remaining, min: minutes })}
          </span>
        </div>
        <Progress
          value={total ? (p.doneCount / total) * 100 : 0}
          aria-label={t("queue.remaining", { count: remaining, min: minutes })}
          indicatorClassName="bg-manual"
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-2">
        {p.loading && !p.items.length ? (
          <p role="status" className="p-2 text-dense text-muted-foreground">
            {t("queue.loading")}
          </p>
        ) : p.error ? (
          <p role="alert" className="p-2 text-dense text-destructive">
            {t("queue.error")}
          </p>
        ) : remaining === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <CheckCircle2 className="size-8 text-conf-high" aria-hidden />
            <p className="font-bold text-foreground">{t("queue.empty")}</p>
            <p className="text-dense text-muted-foreground">{p.doneCount ? t("queue.done", { pct: p.verifiedPct }) : t("queue.emptyBody")}</p>
          </div>
        ) : (
          <ol ref={listRef} aria-label={t("queue.listLabel")} className="flex flex-col gap-1.5">
            {p.items.map((it) => (
              <li key={it.id} data-queue-item={it.id}>
                <QueueCard
                  item={it}
                  active={it.id === p.activeId}
                  projectId={p.projectId}
                  handlers={p.handlers}
                  row={p.rows.get(it.sheetId) ?? null}
                  otherSheet={it.sheetId !== p.currentSheetId}
                  exceptions={p.exceptions[it.id] ?? EMPTY}
                  unknown={it.kind === "unknown_cluster" ? p.unknown : undefined}
                />
              </li>
            ))}
          </ol>
        )}
      </div>
      <p className="shrink-0 border-t border-border px-3 py-1.5 text-meta text-muted-foreground">{t("queue.keysHint")}</p>
    </section>
  );
}
const EMPTY: readonly string[] = [];

interface CardProps {
  projectId: string;
  handlers: QueueHandlers;
  item: ReviewQueueItem;
  active: boolean;
  row: SheetRow | null;
  otherSheet: boolean;
  exceptions: readonly string[];
  unknown?: UnknownContext | undefined;
}

const QueueCard = memo(function QueueCard(p: CardProps) {
  const { t } = useTranslation();
  const it = p.item;
  const level = it.level === "unknown" ? "unknown" : uiLevel(it.level);
  const name = it.class ? className(it.class) : "";
  const title =
    it.kind === "cluster"
      ? t("queue.clusterTitle", { name, count: it.members?.length ?? 0 })
      : it.kind === "unknown_cluster"
        ? t("unknown.card", { count: it.members?.length || it.detectionIds?.length || 0 })
        : it.kind === "link_group"
          ? t("queue.linkTitle", { count: it.detectionIds?.length ?? 0 })
          : it.kind === "room"
            ? t("queue.roomTitle", { name: it.title ?? t("understanding.unnamedRoom") })
            : it.kind === "unmatched_correction"
              ? t("queue.unmatchedTitle", { name: name || "—" })
              : it.kind === "line"
                ? t("queue.lineTitle", { code: it.itemCode ?? "" })
                : name;
  const titleId = `q-${it.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const impact = impactOf(it.risk);
  const isCluster = it.kind === "cluster";
  const h = p.handlers;
  const cluster = it.kind === "unknown_cluster" ? (p.unknown?.clusters.find((c) => c.id === it.clusterId) ?? null) : null;

  return (
    <article
      aria-labelledby={titleId}
      aria-current={p.active || undefined}
      data-kind={it.kind}
      data-active={p.active || undefined}
      className={cn(
        "relative flex flex-col gap-1.5 rounded border bg-surface p-2 text-start",
        p.active ? "border-primary ring-1 ring-primary" : "border-border hover:border-foreground/30",
        it.kind === "unknown_cluster" && !p.active && "border-conf-unknown/40",
      )}
    >
      <button
        type="button"
        onClick={() => h.onActivate(it)}
        aria-label={t("understanding.focusItem", { name: title })}
        className="flex w-full flex-col gap-1 rounded-sm text-start"
      >
        <span className="flex items-center gap-1.5">
          <ConfidenceBadge level={level} size="sm" />
          <span className="text-meta text-muted-foreground">{t(`queue.kind.${it.kind}`)}</span>
          <span className={cn("ms-auto whitespace-nowrap text-meta", impact === "high" ? "font-medium text-conf-low" : "text-muted-foreground")}>
            {t("queue.impact")}: {t(`queue.impact${impact[0]!.toUpperCase()}${impact.slice(1)}`)}
          </span>
        </span>
        <span id={titleId} className="text-dense font-medium text-foreground">
          {it.kind === "line" && it.itemCode ? (
            <>
              {t("queue.lineTitle", { code: "" }).trim()} <Ltr>{it.itemCode}</Ltr>
            </>
          ) : (
            title
          )}
          {it.itemCode && it.kind !== "line" ? (
            <span className="text-muted-foreground">
              {" "}
              (<Ltr>{it.itemCode}</Ltr>)
            </span>
          ) : null}
        </span>
        {it.kind === "line" && it.title ? <span className="line-clamp-2 text-meta text-muted-foreground">{it.title}</span> : null}
        {p.otherSheet && p.row ? <span className="text-meta text-muted-foreground">{t("queue.otherSheet", { sheet: sheetName(p.row) })}</span> : null}
      </button>
      {it.reasons.length ? (
        <span className="flex flex-wrap gap-1">
          {it.reasons.slice(0, 2).map((r) => (
            <ReasonChip key={r} code={r} />
          ))}
        </span>
      ) : null}

      {isCluster && it.members ? <ClusterThumbs {...p} /> : null}
      {it.kind === "detection" && p.active && it.members === undefined ? (
        <TileCrop projectId={p.projectId} row={p.row} bboxMm={it.bboxMm} alt={name} size={56} />
      ) : null}
      {cluster && p.unknown ? <UnknownClusterBody {...p} unknown={p.unknown} cluster={cluster} /> : null}

      {p.active && it.kind !== "unknown_cluster" ? (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <Button size="sm" onClick={() => h.onAccept(it)} aria-keyshortcuts="A">
            <Kbd className="border-primary-foreground/40 bg-transparent text-primary-foreground">A</Kbd>
            {isCluster ? t("queue.acceptAll") : it.kind === "room" ? t("queue.accept") : t("queue.accept")}
          </Button>
          {it.kind !== "room" && it.kind !== "line" ? (
            <Button size="sm" variant="secondary" onClick={() => h.onReject(it)} aria-keyshortcuts="R">
              <Kbd>R</Kbd>
              {isCluster ? t("queue.rejectAll") : t("queue.reject")}
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => h.onEdit(it)} aria-keyshortcuts="E">
            <Kbd>E</Kbd>
            {it.kind === "room" ? (
              <>
                <Settings2 aria-hidden />
                {t("queue.openRoom")}
              </>
            ) : (
              t("queue.edit")
            )}
          </Button>
        </div>
      ) : null}
    </article>
  );
});

function ClusterThumbs(p: CardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const members = p.item.members ?? [];
  const shown = members.slice(0, open ? THUMBS_EXPANDED : THUMBS);
  const ex = new Set(p.exceptions);
  const name = p.item.class ? className(p.item.class) : "";
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-wrap gap-1" aria-label={t("unknown.locations")}>
        {shown.map((m, i) => {
          const isEx = ex.has(m.detectionId);
          return (
            <li key={m.detectionId}>
              <button
                type="button"
                aria-pressed={isEx}
                aria-label={`${t("queue.thumbAlt", { n: i + 1, name })} · ${isEx ? t("queue.exceptionOff") : t("queue.exceptionOn")}`}
                title={isEx ? t("queue.exceptionOff") : t("queue.exceptionOn")}
                onClick={() => p.handlers.onToggleException(p.item.id, m.detectionId)}
                onMouseEnter={() => p.handlers.onHoverMember(m.detectionId)}
                onMouseLeave={() => p.handlers.onHoverMember(null)}
                onFocus={() => p.handlers.onHoverMember(m.detectionId)}
                onBlur={() => p.handlers.onHoverMember(null)}
                className={cn("relative block rounded-sm", isEx && "ring-2 ring-destructive")}
              >
                <TileCrop projectId={p.projectId} row={p.row} bboxMm={m.bboxMm} alt="" size={open ? 52 : 44} src={m.thumbUrl} />
                {isEx ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-destructive/20">
                    <X className="size-5 text-destructive" aria-hidden />
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
        {!open && members.length > THUMBS ? (
          <li className="self-center px-1 text-meta text-muted-foreground">{t("queue.more", { count: members.length - THUMBS })}</li>
        ) : null}
      </ul>
      <div className="flex items-center gap-2">
        {members.length > THUMBS ? (
          <button type="button" className="text-meta text-primary hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? t("queue.collapse") : t("queue.expand")}
          </button>
        ) : null}
        {ex.size ? <span className="text-meta text-destructive">{t("queue.exceptions", { count: ex.size })}</span> : null}
      </div>
    </div>
  );
}

/** "מה זה?" (spec flow 7): one answer for the whole cluster; locations jump the drawing. */
function UnknownClusterBody(p: CardProps & { cluster: UnknownCluster; unknown: UnknownContext }) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const c = p.cluster;
  const members = (p.item.detectionIds ?? []).map((id) => p.unknown.detById.get(id)).filter((d): d is Detection => Boolean(d));
  const count = members.length || c.count;
  const thumb = p.unknown.thumbs[c.id] ?? p.item.thumbUrl ?? null;
  const apply = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      await p.handlers.onResolve(c, choice === IGNORE ? null : choice, remember);
    } catch {
      toast({ title: t("unknown.error"), tone: "error" });
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        {thumb ? (
          <img src={thumb} alt={t("unknown.thumbAlt")} className="size-14 shrink-0 rounded-sm border border-border bg-white object-contain" />
        ) : (
          <span className="paper-grid flex size-14 shrink-0 items-center justify-center rounded-sm border border-dashed border-conf-unknown/50">
            <ConfidenceShape level="unknown" className="size-5" />
          </span>
        )}
        {members.length ? (
          <ul className="flex flex-wrap gap-1">
            {members.slice(0, 8).map((d, i) => {
              const room = d.roomId ? p.unknown.rooms.get(d.roomId) : undefined;
              const roomName = room ? ` · ${room.name ?? t("understanding.unnamedRoom")}` : "";
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => p.handlers.onJumpDetection(d)}
                    className="inline-flex h-6 items-center gap-1 rounded-sm border border-border px-1.5 text-meta text-foreground hover:bg-muted"
                  >
                    <Crosshair className="size-3 text-muted-foreground" aria-hidden />
                    {t("unknown.location", { n: i + 1, room: roomName })}
                  </button>
                </li>
              );
            })}
            {members.length > 8 ? <li className="self-center text-meta text-muted-foreground">+{members.length - 8}</li> : null}
          </ul>
        ) : null}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium text-foreground">{t("unknown.chooseLabel")}</span>
        <ClassSelect
          value={choice}
          onValueChange={setChoice}
          placeholder={t("unknown.choose")}
          extra={[{ value: IGNORE, label: t("unknown.notRelevant") }]}
          disabled={busy}
        />
      </label>
      <label className="flex items-center gap-1.5 text-meta text-foreground">
        <input
          type="checkbox"
          checked={remember}
          disabled={choice === IGNORE || busy}
          onChange={(e) => setRemember(e.target.checked)}
          className="size-3.5 accent-[rgb(var(--primary))]"
        />
        {t("unknown.remember")}
      </label>
      <Button size="sm" onClick={() => void apply()} disabled={!choice || busy}>
        {t("unknown.apply", { count })}
      </Button>
    </div>
  );
}
