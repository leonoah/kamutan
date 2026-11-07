import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/api/client";
import { GREEN_THRESHOLD_DEFAULT, GREEN_THRESHOLD_MAX, GREEN_THRESHOLD_MIN, VAT_RATE_DEFAULT, type OrgSettings, type PatchOrgSettingsRequest } from "@/api/types";
import { Input } from "@/components/ui/input";
import { parsePct, round2 } from "@/features/prices/model";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Ltr } from "@/components/Ltr";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { useReauthGate } from "@/features/auth/reauth";
import { cn } from "@/lib/utils";

type Editable = Required<PatchOrgSettingsRequest>;
const KEYS = ["greenThreshold", "blockExportOnRed", "llmEnabled", "trainingOptIn", "vatRate"] as const;

export function fromOrg(s: Partial<OrgSettings> | undefined): Editable {
  return {
    greenThreshold: s?.greenThreshold ?? GREEN_THRESHOLD_DEFAULT,
    blockExportOnRed: s?.blockExportOnRed ?? true,
    llmEnabled: s?.llmEnabled ?? false,
    trainingOptIn: s?.trainingOptIn ?? false,
    vatRate: s?.vatRate ?? VAT_RATE_DEFAULT,
  };
}
/** Sprint 8: VAT is typed as a percent ("18", "17.5"); stored as a rate (0.18). */
const vatPctText = (rate: number) => String(round2(rate * 100));
/** Only changed fields go to PATCH (each change is one audit event server side). */
export function diffSettings(a: Editable, b: Editable): PatchOrgSettingsRequest {
  const out: PatchOrgSettingsRequest = {};
  for (const k of KEYS) if (a[k] !== b[k]) (out as Record<string, unknown>)[k] = b[k];
  return out;
}
const fmtThreshold = (v: number) => v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");

/** S14 policy (FR-31): green threshold, block export on red, external LLM, training opt-in. Admin only. */
export function OrgSettingsPage() {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const { org } = useCurrentOrg();
  const saved = useMemo(() => fromOrg(org?.settings), [org?.settings]);
  const [draft, setDraft] = useState<Editable>(saved);
  useEffect(() => setDraft(saved), [saved]);
  const changes = diffSettings(saved, draft);
  const dirty = Object.keys(changes).length > 0;
  // Stage 10 (A-API-02): MFA + a sign-in from the last 10 minutes, like offboarding.
  const gate = useReauthGate();
  const save = useMutation({
    mutationFn: () => api.patchOrgSettings(org!.id, changes),
    onSuccess: () => {
      toast({ title: t("settings.saved"), tone: "success" });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e) => {
      if (!gate.handle(e, () => save.mutate())) toast({ title: t("settings.saveError"), tone: "error" });
    },
  });
  const gtId = useId();
  const vatId = useId();
  const [vatText, setVatText] = useState(() => vatPctText(saved.vatRate));
  useEffect(() => setVatText(vatPctText(saved.vatRate)), [saved.vatRate]);
  const vatPct = parsePct(vatText, 0, 50);
  const vatBad = vatPct === null || Number.isNaN(vatPct);
  if (!org) return null;

  return (
    <div className="flex flex-col gap-4">
    {/* outside the settings <form>: the re-authentication box has its own password form */}
    {gate.element}
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !vatBad) void gate.guard(() => save.mutate());
      }}
      data-org-settings
    >
      <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={gtId} className="text-body font-bold text-foreground">{t("settings.greenThreshold")}</label>
          <Ltr className="text-panel font-bold tabular text-foreground">{fmtThreshold(draft.greenThreshold)}</Ltr>
        </div>
        <input
          id={gtId}
          type="range"
          min={GREEN_THRESHOLD_MIN}
          max={GREEN_THRESHOLD_MAX}
          step={0.005}
          value={draft.greenThreshold}
          onChange={(e) => setDraft((d) => ({ ...d, greenThreshold: Number(e.target.value) }))}
          aria-valuetext={fmtThreshold(draft.greenThreshold)}
          aria-describedby={`${gtId}-h`}
          className="w-full accent-[rgb(var(--primary))]"
        />
        <div className="flex justify-between text-meta text-muted-foreground" aria-hidden>
          <Ltr>{fmtThreshold(GREEN_THRESHOLD_MIN)}</Ltr>
          <Ltr>{fmtThreshold(GREEN_THRESHOLD_MAX)}</Ltr>
        </div>
        <p id={`${gtId}-h`} className="text-dense text-muted-foreground">{t("settings.greenThresholdHint")}</p>
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5" data-vat-setting>
        <label htmlFor={vatId} className="text-body font-bold text-foreground">{t("prices.vat.label")}</label>
        <div className="flex items-center gap-2">
          <Input
            id={vatId}
            inputMode="decimal"
            dir="ltr"
            value={vatText}
            onChange={(e) => {
              setVatText(e.target.value);
              const v = parsePct(e.target.value, 0, 50);
              if (v !== null && !Number.isNaN(v)) setDraft((d) => ({ ...d, vatRate: Math.round(v * 100) / 10_000 }));
            }}
            aria-invalid={vatBad}
            aria-describedby={`${vatId}-h`}
            className="w-24 text-end tabular"
          />
          <span aria-hidden className="text-body text-muted-foreground">%</span>
        </div>
        <p id={`${vatId}-h`} className={cn("text-dense", vatBad ? "text-destructive" : "text-muted-foreground")} role={vatBad ? "alert" : undefined}>
          {vatBad ? t("prices.vat.invalid") : t("prices.vat.hint")}
        </p>
      </section>

      <section className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        <SwitchRow label={t("settings.blockExportOnRed")} hint={t("settings.blockExportOnRedHint")} checked={draft.blockExportOnRed} onChange={(v) => setDraft((d) => ({ ...d, blockExportOnRed: v }))} />
        <SwitchRow label={t("settings.llmEnabled")} hint={t("settings.llmEnabledHint")} checked={draft.llmEnabled} onChange={(v) => setDraft((d) => ({ ...d, llmEnabled: v }))} />
        <SwitchRow label={t("settings.trainingOptIn")} hint={t("settings.trainingOptInHint")} checked={draft.trainingOptIn} onChange={(v) => setDraft((d) => ({ ...d, trainingOptIn: v }))} />
      </section>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!dirty || vatBad || save.isPending || gate.pending}>
          {save.isPending ? t("settings.saving") : t("settings.save")}
        </Button>
        {dirty ? (
          <>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft(saved);
                setVatText(vatPctText(saved.vatRate));
              }}
            >
              {t("settings.reset")}
            </Button>
            <span role="status" className="text-dense text-muted-foreground">{t("settings.unsaved")}</span>
          </>
        ) : null}
      </div>
    </form>
    </div>
  );
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="flex items-start gap-4 p-5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <label htmlFor={id} className="cursor-pointer text-body font-bold text-foreground">{label}</label>
        <p id={`${id}-h`} className="text-dense text-muted-foreground">{hint}</p>
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={`${id}-h`}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors", checked ? "border-primary bg-primary" : "border-input bg-muted")}
      >
        <span className="sr-only">{checked ? t("settings.on") : t("settings.off")}</span>
        <span aria-hidden className={cn("absolute top-0.5 size-[18px] rounded-full bg-surface shadow transition-[inset-inline-start]", checked ? "start-[22px]" : "start-0.5")} />
      </button>
    </div>
  );
}
