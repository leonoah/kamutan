import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, MousePointerClick, Trash2 } from "lucide-react";
import { ROOM_TYPES, type Room, type RoomSettings, type RoomSettingsDoc, type RoomType, type RoomWall } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ConfidenceBadge, levelFromDb } from "@/components/ConfidenceBadge";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { defaultSettings, isWet, openingsOf, roomTypeOf, tilingQuantities } from "./model";

const nf = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2 });
const n2 = (v: number) => nf.format(Math.round(v * 100) / 100);

export interface RoomPanelProps {
  room: Room;
  walls: RoomWall[];
  saved: RoomSettingsDoc | null;
  /** The wall the user just clicked on the drawing (partial cladding), bumped by `seq`. */
  wallPick: { wallId: string; seq: number } | null;
  pickingWall: boolean;
  onPickingWall: (on: boolean) => void;
  /** Live draft → the drawing highlights the partial-cladding walls. */
  onDraftChange?: (s: RoomSettings) => void;
  onSave: (s: RoomSettings) => Promise<void>;
  onClose: () => void;
  saving: boolean;
}

/**
 * Room panel (spec "חיפוי": בחירת חדר ← היקף אוטומטי ← גובה חיפוי ← החסרת פתחים ← נטו + להזמנה): type, wet flag,
 * area / perimeter / openings, cladding height, floor tiling, partial cladding per wall (picked on the drawing),
 * waterproofing and waste → PUT room settings. The preview shows what the room adds to chapter 05.
 */
export function RoomPanel(p: RoomPanelProps) {
  const { t } = useTranslation();
  const base = useMemo(() => p.saved ?? defaultSettings(p.room), [p.saved, p.room]);
  const [s, setS] = useState<RoomSettings>(base);
  const ids = { type: useId(), h: useId(), waste: useId() };
  useEffect(() => setS(base), [base]);
  useEffect(() => p.onDraftChange?.(s), [s]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!p.wallPick) return;
    const w = p.walls.find((x) => x.id === p.wallPick!.wallId);
    if (!w) return;
    setS((cur) =>
      cur.partialCladding.some((x) => x.wallId === w.id)
        ? cur
        : {
            ...cur,
            partialCladding: [
              ...cur.partialCladding,
              { wallId: w.id, fromM: 0, toM: w.lengthM, heightM: roomTypeOf(p.room, cur.type) === "kitchen" ? 0.6 : 1.2 },
            ],
          },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.wallPick?.seq]);

  const type = roomTypeOf(p.room, s.type);
  const wet = isWet(p.room, s);
  const q = tilingQuantities(p.room, s);
  const openings = openingsOf(p.room);
  const excluded = new Set(s.keepOpenings ?? []);
  const set = (patch: Partial<RoomSettings>) => setS((cur) => ({ ...cur, ...patch }));
  const wallNo = (id: string) => p.walls.findIndex((w) => w.id === id) + 1;
  const num = (v: string, fallback: number) => {
    const x = Number(v.replace(",", "."));
    return Number.isFinite(x) ? x : fallback;
  };

  return (
    <section aria-labelledby="room-panel-title" className="flex min-h-0 flex-1 flex-col" data-room-panel={p.room.id}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button size="icon-sm" variant="ghost" onClick={p.onClose} aria-label={t("room.back")} title={t("room.back")}>
          <ArrowRight className="ltr:rotate-180" aria-hidden />
        </Button>
        <h2 id="room-panel-title" className="min-w-0 flex-1 truncate text-panel text-foreground">
          {t("room.title")}: {p.room.name ?? t("understanding.unnamedRoom")}
        </h2>
        {p.saved ? <ConfidenceBadge level="manual" size="sm" /> : <ConfidenceBadge level={levelFromDb(p.room.level)} size="sm" />}
      </div>
      <form
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 text-dense"
        onSubmit={(e) => {
          e.preventDefault();
          void p.onSave(s);
        }}
      >
        {!p.saved ? <p className="rounded-sm bg-conf-mid/10 px-2 py-1 text-meta text-foreground">{t("room.unsaved")}</p> : null}
        <div className="grid grid-cols-2 gap-2">
          <label htmlFor={ids.type} className="flex flex-col gap-1">
            <span className="text-meta font-medium text-foreground">{t("room.type")}</span>
            <select
              id={ids.type}
              value={type}
              onChange={(e) => {
                const nt = e.target.value as RoomType;
                // A new type brings that type's defaults (until the user saved their own values).
                setS((cur) => ({ ...(p.saved ? cur : defaultSettings(p.room, nt)), type: nt }));
              }}
              className="h-8 rounded-sm border border-input bg-surface px-1.5 text-foreground"
            >
              {ROOM_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`room.types.${x}`)}
                </option>
              ))}
            </select>
          </label>
          <span className="flex items-center gap-1.5 self-end pb-1.5 text-foreground" data-wet={wet || undefined}>
            <span aria-hidden className={cn("inline-block size-2.5 rounded-full", wet ? "bg-primary" : "border border-input")} />
            {wet ? t("room.wet") : t("room.dry")}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-sm bg-surface-sunken px-2.5 py-2">
          <dt className="text-muted-foreground">{t("room.area")}</dt>
          <dd className="text-end">
            <Ltr className="tabular">{n2(p.room.areaM2)}</Ltr> מ״ר
          </dd>
          <dt className="text-muted-foreground">{t("room.perimeter")}</dt>
          <dd className="text-end">
            <Ltr className="tabular">{n2(p.room.perimeterM)}</Ltr> מ״א
          </dd>
        </dl>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-meta font-medium text-foreground">{t("room.cladding")}</legend>
          <label htmlFor={ids.h} className="flex items-center justify-between gap-2">
            <span>{t("room.claddingHeight")}</span>
            <input
              id={ids.h}
              type="number"
              inputMode="decimal"
              min={0}
              max={6}
              step={0.05}
              dir="ltr"
              value={s.claddingHeightM}
              onChange={(e) => set({ claddingHeightM: Math.max(0, num(e.target.value, s.claddingHeightM)) })}
              className="h-8 w-20 rounded-sm border border-input bg-surface px-1.5 text-end tabular"
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-meta text-muted-foreground">{t("room.openings")}</span>
            {openings.length === 0 ? <span className="text-meta text-muted-foreground">{t("room.openingsNone")}</span> : null}
            {openings.map((o) => (
              <label key={o.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={!excluded.has(o.id)}
                  onChange={(e) => {
                    const next = new Set(excluded);
                    if (e.target.checked) next.delete(o.id);
                    else next.add(o.id);
                    set({ keepOpenings: [...next] });
                  }}
                  className="size-3.5 accent-[rgb(var(--primary))]"
                />
                <span>
                  {t(`room.opening.${o.kind}`)} ·{" "}
                  <Ltr>{t("room.openingSize", { w: n2(o.widthM), h: n2(o.heightM ?? (o.kind === "window" ? 1.2 : 2.1)) })}</Ltr>
                </span>
                <span className="ms-auto text-meta text-muted-foreground">{t("room.openingInclude")}</span>
              </label>
            ))}
          </div>
          {q.claddingNetM2 > 0 ? (
            // "היקף × גובה − פתחים = נטו": Hebrew units in reading order, each number LTR-isolated.
            <p className="rounded-sm border border-border px-2 py-1 text-meta text-foreground" data-testid="cladding-formula">
              <Ltr>{n2(q.perimeterM)}</Ltr> מ״א × <Ltr>{n2(s.claddingHeightM)}</Ltr> מ׳ − <Ltr>{n2(q.openingsM2)}</Ltr> מ״ר {t("room.openingsShort")}{" "}
              = <Ltr className="font-bold">{n2(q.claddingNetM2)}</Ltr> מ״ר
            </p>
          ) : null}
        </fieldset>

        <label className="flex items-center gap-1.5 text-foreground">
          <input
            type="checkbox"
            checked={s.floorTiled}
            onChange={(e) => set({ floorTiled: e.target.checked })}
            className="size-3.5 accent-[rgb(var(--primary))]"
          />
          {t("room.floorTiled")}
        </label>
        <label className="flex items-center gap-1.5 text-foreground">
          <input
            type="checkbox"
            checked={s.includeInWaterproofing}
            onChange={(e) => set({ includeInWaterproofing: e.target.checked })}
            className="size-3.5 accent-[rgb(var(--primary))]"
          />
          {t("room.waterproofing")}
        </label>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-meta font-medium text-foreground">{t("room.partial")}</legend>
          {s.partialCladding.length === 0 ? <span className="text-meta text-muted-foreground">{t("room.partialNone")}</span> : null}
          {s.partialCladding.map((pc, i) => {
            const w = p.walls.find((x) => x.id === pc.wallId);
            const upd = (patch: Partial<typeof pc>) => set({ partialCladding: s.partialCladding.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={pc.wallId} className="flex flex-wrap items-center gap-1.5 rounded-sm border border-border px-2 py-1" data-partial={pc.wallId}>
                <span className="min-w-24 text-foreground">{t("room.partialWall", { n: wallNo(pc.wallId), len: n2(w?.lengthM ?? pc.toM) })}</span>
                {(["fromM", "toM", "heightM"] as const).map((k) => (
                  <label key={k} className="inline-flex items-center gap-1 text-meta text-muted-foreground">
                    {t(k === "fromM" ? "room.partialFrom" : k === "toM" ? "room.partialTo" : "room.partialHeight")}
                    <input
                      type="number"
                      step={0.05}
                      min={0}
                      dir="ltr"
                      value={pc[k]}
                      onChange={(e) => upd({ [k]: Math.max(0, num(e.target.value, pc[k])) })}
                      className="h-7 w-14 rounded-sm border border-input bg-surface px-1 text-end tabular text-foreground"
                    />
                  </label>
                ))}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("room.partialRemove")}
                  onClick={() => set({ partialCladding: s.partialCladding.filter((_, j) => j !== i) })}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            );
          })}
          <Button
            type="button"
            size="sm"
            variant={p.pickingWall ? "subtle" : "secondary"}
            aria-pressed={p.pickingWall}
            onClick={() => p.onPickingWall(!p.pickingWall)}
            className="self-start"
          >
            <MousePointerClick aria-hidden />
            {p.pickingWall ? t("room.partialPicking") : t("room.partialPick")}
          </Button>
        </fieldset>

        <label htmlFor={ids.waste} className="flex items-center justify-between gap-2">
          <span>{t("room.waste")}</span>
          <input
            id={ids.waste}
            type="number"
            min={0}
            max={50}
            step={1}
            dir="ltr"
            value={Math.round(s.wasteFactor * 100)}
            onChange={(e) => set({ wasteFactor: Math.min(0.5, Math.max(0, num(e.target.value, s.wasteFactor * 100) / 100)) })}
            className="h-8 w-20 rounded-sm border border-input bg-surface px-1.5 text-end tabular"
          />
        </label>

        <section aria-labelledby="room-preview" className="rounded border border-border">
          <h3 id="room-preview" className="border-b border-border bg-surface-sunken px-2.5 py-1.5 text-meta font-bold text-foreground">
            {t("room.preview")}
          </h3>
          <dl className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-2 gap-y-1 px-2.5 py-2" data-testid="room-preview">
            {[
              { k: "previewFloor", code: "5.02", v: q.floorM2, unit: "m2" },
              { k: "previewCladding", code: "5.01", v: q.claddingNetM2, unit: "m2" },
              { k: "previewPartial", code: type === "kitchen" ? "5.06" : q.claddingNetM2 > 0 ? "5.01" : "5.07", v: q.partialM2, unit: "m2" },
              { k: "previewCorners", code: "5.03", v: q.cornersM, unit: "m" },
              { k: "previewWaterproofing", code: "5.05", v: q.waterproofing, unit: "complete" },
            ]
              .filter((r) => r.v > 0)
              .map((r) => (
                <div key={r.k} className="contents">
                  <dt className="text-foreground">{t(`room.${r.k}`)}</dt>
                  <dd className="text-meta text-muted-foreground">
                    <Ltr>{r.code}</Ltr>
                  </dd>
                  <dd className={cn("text-end font-medium text-foreground")}>
                    {r.unit === "m2" ? (
                      <>
                        <Ltr className="tabular">{n2(r.v)}</Ltr> מ״ר
                      </>
                    ) : r.unit === "m" ? (
                      <>
                        <Ltr className="tabular">{n2(r.v)}</Ltr> מ״א
                      </>
                    ) : (
                      t("room.complete", { v: r.v })
                    )}
                  </dd>
                </div>
              ))}
            <dt className="col-span-2 border-t border-border pt-1 text-muted-foreground">{t("room.previewOrder")}</dt>
            <dd className="border-t border-border pt-1 text-end font-bold text-foreground">
              <Ltr className="tabular">{n2(q.orderM2)}</Ltr> מ״ר
            </dd>
          </dl>
        </section>
        <Button type="submit" disabled={p.saving} className="self-stretch">
          {t("room.save")}
        </Button>
      </form>
    </section>
  );
}
