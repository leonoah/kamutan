import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Crosshair, HelpCircle } from "lucide-react";
import type { Detection, Room, UnknownCluster } from "@/api/types";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ConfidenceBadge, ConfidenceShape } from "@/components/ConfidenceBadge";
import { ReasonChip } from "@/components/ReasonChip";
import { cn } from "@/lib/utils";
import { levelKeyOf, uiLevel } from "@/features/understanding/model";
import { ClassSelect } from "@/features/understanding/ClassSelect";
import { className } from "@/features/understanding/taxonomy";

const IGNORE = "__ignore";
const MAX_LOCATIONS = 8;

/**
 * Left pane (spec: תור בדיקה): first the "מה זה?" cards — one question per unknown-symbol cluster
 * (spec flow 7 / S11) — then the non-green items, lowest score first. Clicking an item or a location jumps
 * the drawing to it.
 */
export function QueuePanel({
  clusters,
  clusterMembers,
  thumbs,
  queue,
  rooms,
  activeId,
  onJump,
  onResolve,
  loading,
}: {
  clusters: UnknownCluster[];
  clusterMembers: Map<string, Detection[]>;
  thumbs: Record<string, string>;
  queue: Detection[];
  rooms: Map<string, Room>;
  activeId: string | null;
  onJump: (d: Detection) => void;
  onResolve: (cluster: UnknownCluster, cls: string | null, remember: boolean) => Promise<void>;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const total = queue.length + clusters.length;
  return (
    <section id="queue-panel" tabIndex={-1} aria-label={t("review.queuePanel")} className="flex min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <h2 className="text-panel text-foreground">{t("review.queuePanel")}</h2>
        <span className="text-meta text-muted-foreground">{t("review.queueCount", { count: total })}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-2">
        {loading ? (
          <p role="status" className="p-2 text-dense text-muted-foreground">
            {t("understanding.loading")}
          </p>
        ) : null}

        <section aria-labelledby="unknown-title" className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 px-1">
            <HelpCircle className="size-4 text-conf-unknown" aria-hidden />
            <h3 id="unknown-title" className="text-dense font-bold text-foreground">
              {t("unknown.title")}
            </h3>
          </div>
          {clusters.length === 0 ? (
            <p className="px-1 text-meta text-muted-foreground">{t("unknown.none")}</p>
          ) : (
            <>
              <p className="px-1 text-meta text-muted-foreground">{t("unknown.subtitle")}</p>
              <ol className="flex flex-col gap-2">
                {clusters.map((c) => (
                  <li key={c.id}>
                    <ClusterCard
                      cluster={c}
                      members={clusterMembers.get(c.id) ?? []}
                      thumb={thumbs[c.id] ?? null}
                      rooms={rooms}
                      onJump={onJump}
                      onResolve={onResolve}
                    />
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>

        <section aria-labelledby="queue-title" className="flex flex-col gap-2">
          <h3 id="queue-title" className="px-1 text-dense font-bold text-foreground">
            {t("understanding.queueTitle")}
          </h3>
          {queue.length === 0 ? (
            <p className="px-1 text-meta text-muted-foreground">{t("understanding.queueEmpty")}</p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {queue.slice(0, 60).map((d) => {
                const room = d.roomId ? rooms.get(d.roomId) : undefined;
                const name = className(d.class);
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => onJump(d)}
                      aria-current={activeId === d.id || undefined}
                      aria-label={t("understanding.focusItem", { name })}
                      className={cn(
                        "flex w-full flex-col gap-1 rounded border bg-surface p-2 text-start hover:border-foreground/30",
                        activeId === d.id ? "border-primary ring-1 ring-primary" : "border-border",
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <ConfidenceBadge level={uiLevel(levelKeyOf(d))} size="sm" />
                        <span className="truncate text-dense font-medium text-foreground">{name}</span>
                      </span>
                      <span className="text-meta text-muted-foreground">
                        {room ? (room.name ?? t("understanding.unnamedRoom")) : t("understanding.noRoom")}
                      </span>
                      {d.reasons[0] ? <ReasonChip code={d.reasons[0]} className="self-start" /> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </section>
  );
}

function ClusterCard({
  cluster,
  members,
  thumb,
  rooms,
  onJump,
  onResolve,
}: {
  cluster: UnknownCluster;
  members: Detection[];
  thumb: string | null;
  rooms: Map<string, Room>;
  onJump: (d: Detection) => void;
  onResolve: (cluster: UnknownCluster, cls: string | null, remember: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const count = members.length || cluster.count;
  const titleId = `cluster-${cluster.id}`;

  const apply = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      await onResolve(cluster, choice === IGNORE ? null : choice, remember);
    } catch {
      toast({ title: t("unknown.error"), tone: "error" });
      setBusy(false);
    }
  };

  return (
    <article aria-labelledby={titleId} className="flex flex-col gap-2 rounded border border-conf-unknown/40 bg-surface p-2.5" data-cluster={cluster.id}>
      <div className="flex items-start gap-2">
        {thumb ? (
          <img src={thumb} alt={t("unknown.thumbAlt")} className="size-14 shrink-0 rounded-sm border border-border bg-white object-contain" />
        ) : (
          <span className="paper-grid flex size-14 shrink-0 items-center justify-center rounded-sm border border-dashed border-conf-unknown/50">
            <ConfidenceShape level="unknown" className="size-5" />
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <ConfidenceBadge level="unknown" size="sm" className="self-start" />
          <h4 id={titleId} className="text-dense font-medium text-foreground">
            {t("unknown.card", { count })}
          </h4>
        </div>
      </div>

      {members.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-meta text-muted-foreground">{t("unknown.locations")}</span>
          <ul className="flex flex-wrap gap-1">
            {members.slice(0, MAX_LOCATIONS).map((d, i) => {
              const room = d.roomId ? rooms.get(d.roomId) : undefined;
              const roomName = room ? ` · ${room.name ?? t("understanding.unnamedRoom")}` : "";
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => onJump(d)}
                    className="inline-flex h-6 items-center gap-1 rounded-sm border border-border px-1.5 text-meta text-foreground hover:bg-muted"
                  >
                    <Crosshair className="size-3 text-muted-foreground" aria-hidden />
                    {t("unknown.location", { n: i + 1, room: roomName })}
                  </button>
                </li>
              );
            })}
            {members.length > MAX_LOCATIONS ? <li className="self-center text-meta text-muted-foreground">+{members.length - MAX_LOCATIONS}</li> : null}
          </ul>
        </div>
      ) : null}

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
    </article>
  );
}
