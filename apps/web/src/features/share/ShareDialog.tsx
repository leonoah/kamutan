import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Copy, Eye, Link2, Link2Off, Plus } from "lucide-react";
import { SHARE_LINK_DEFAULT_DAYS, SHARE_LINK_MAX_DAYS, type CreateShareLinkResponse, type ShareLink } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { Ltr } from "@/components/Ltr";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { linkState, useCreateShareLink, useRevokeShareLink, useShareLinks } from "./queries";

const QUICK_DAYS = [7, 14, 30, 90] as const;
const DAY = 86_400_000;

/**
 * S12 "קישור צפייה" (FR-30, SEC-26–29): create a read-only expiring link (1–90 days, default 14; label; optional
 * recipient for the watermark; hide title block ON; allow PDF OFF). The URL holds the raw token and is shown ONCE
 * with a copy button. Below: the project's links with expiry / views / revoked, and revoke behind a confirmation.
 */
export function ShareDialog({
  projectId,
  open,
  onOpenChange,
  canManage,
  sheetNames = {},
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  canManage: boolean;
  /** sheetId → display name (per-sheet title-block status after creation, F-3). */
  sheetNames?: Readonly<Record<string, string>>;
}) {
  const { t } = useTranslation();
  const links = useShareLinks(projectId, open);
  const create = useCreateShareLink(projectId);
  const revoke = useRevokeShareLink(projectId);
  const ids = { label: useId(), recipient: useId(), days: useId(), tb: useId(), pdf: useId(), url: useId(), unm: useId() };
  const [label, setLabel] = useState("");
  const [recipient, setRecipient] = useState("");
  const [days, setDays] = useState(String(SHARE_LINK_DEFAULT_DAYS));
  const [hideTitleBlock, setHideTitleBlock] = useState(true);
  const [allowPdf, setAllowPdf] = useState(false);
  const [includeUnmasked, setIncludeUnmasked] = useState(false);
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<CreateShareLinkResponse | null>(null);
  const [confirm, setConfirm] = useState<ShareLink | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setLabel("");
    setRecipient("");
    setDays(String(SHARE_LINK_DEFAULT_DAYS));
    setHideTitleBlock(true);
    setAllowPdf(false);
    setIncludeUnmasked(false);
    setTouched(false);
    setCreated(null);
  };
  // The raw URL must not outlive the dialog (shown once).
  useEffect(() => {
    if (!open) reset();
  }, [open]);

  const n = Number(days);
  const daysOk = Number.isInteger(n) && n >= 1 && n <= SHARE_LINK_MAX_DAYS;
  const labelOk = label.trim().length > 0;
  const until = daysOk ? formatDate(new Date(Date.now() + n * DAY)) : null;

  const submit = async () => {
    setTouched(true);
    if (!daysOk || !labelOk) return;
    try {
      const r = await create.mutateAsync({
        days: n,
        label: label.trim(),
        recipient: recipient.trim() || null,
        hideTitleBlock,
        allowPdfDownload: allowPdf,
        // F-3: explicit opt-in only (sheets without a detected title block cannot be masked).
        ...(hideTitleBlock && includeUnmasked ? { includeUnmaskedSheets: true } : {}),
      });
      setCreated(r);
    } catch {
      toast({ title: t("share.createError"), tone: "error" });
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      toast({ title: t("share.copied", { date: formatDate(created.link.expiresAt) }), tone: "success" });
    } catch {
      urlRef.current?.select();
      toast({ title: t("share.copyFailed"), tone: "error" });
    }
  };

  const doRevoke = async (l: ShareLink) => {
    setConfirm(null);
    try {
      await revoke.mutateAsync(l.id);
      toast({ title: t("share.revoked") });
    } catch {
      toast({ title: t("share.revokeError"), tone: "error" });
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="top-[6vh] max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("share.title")}</DialogTitle>
            <DialogDescription>{t("share.description")}</DialogDescription>
          </DialogHeader>

          {!canManage ? (
            <p role="note" className="rounded-md border border-border bg-surface-sunken p-3 text-dense text-muted-foreground">{t("share.noPermission")}</p>
          ) : created ? (
            <section aria-labelledby={`${ids.url}-t`} className="flex flex-col gap-3 rounded-md border border-conf-high/40 bg-conf-high/[0.06] p-4" data-share-created>
              <p id={`${ids.url}-t`} className="font-bold text-foreground">{t("share.createdTitle")}</p>
              <label htmlFor={ids.url} className="sr-only">{t("share.urlLabel")}</label>
              <div className="flex gap-2">
                <Input
                  ref={urlRef}
                  id={ids.url}
                  readOnly
                  dir="ltr"
                  value={created.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 font-mono text-meta"
                />
                <Button onClick={() => void copy()}>
                  <Copy aria-hidden />
                  {t("share.copy")}
                </Button>
              </div>
              <p className="text-dense text-foreground">{t("share.createdOnce")}</p>
              <p className="text-meta text-muted-foreground">{t("share.expiresOn", { date: formatDate(created.link.expiresAt) })}</p>
              {created.warnings.map((w) => (
                <div key={w.code} role="alert" className="flex gap-2 rounded-md border border-conf-mid/50 bg-conf-mid/[0.1] p-3 text-dense text-foreground" data-share-warning={w.code}>
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-conf-mid" aria-hidden />
                  <div className="flex flex-col gap-1">
                    <p>{w.message}</p>
                    <p className="text-meta text-muted-foreground">{w.sheetIds.map((id) => sheetNames[id] ?? id).join(" · ")}</p>
                  </div>
                </div>
              ))}
              {created.link.sheets?.length ? (
                <details className="text-dense" open={created.warnings.length > 0}>
                  <summary className="cursor-pointer text-muted-foreground">{t("share.sheetsTitle")} ({created.link.sheets.filter((x) => x.included).length}/{created.link.sheets.length})</summary>
                  <ul className="mt-1.5 flex flex-col gap-1" data-share-sheets>
                    {created.link.sheets.map((x) => {
                      const st = !x.included ? "excluded" : !created.link.hideTitleBlock ? "shown" : x.titleBlockMasked ? "masked" : "unmasked";
                      return (
                        <li key={x.sheetId} data-sheet={x.sheetId} data-sheet-state={st} className="flex items-center justify-between gap-3">
                          <span className={cn("truncate", !x.included && "text-muted-foreground line-through")}>{sheetNames[x.sheetId] ?? x.sheetId}</span>
                          <span className={cn("shrink-0 text-meta", st === "unmasked" ? "font-medium text-conf-low" : "text-muted-foreground")}>
                            {t(st === "excluded" ? "share.sheetExcluded" : st === "masked" ? "share.sheetMasked" : st === "unmasked" ? "share.sheetUnmasked" : "share.sheetShown")}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              ) : null}
              <div>
                <Button size="sm" variant="secondary" onClick={reset}>
                  <Plus aria-hidden />
                  {t("share.another")}
                </Button>
              </div>
            </section>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              noValidate
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={ids.label} className="text-dense font-medium text-foreground">{t("share.label")}</label>
                  <Input
                    id={ids.label}
                    value={label}
                    maxLength={120}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t("share.labelPlaceholder")}
                    aria-invalid={touched && !labelOk}
                    aria-describedby={touched && !labelOk ? `${ids.label}-e` : undefined}
                    required
                  />
                  {touched && !labelOk ? <p id={`${ids.label}-e`} className="text-meta text-destructive">{t("share.labelRequired")}</p> : null}
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={ids.recipient} className="text-dense font-medium text-foreground">{t("share.recipient")}</label>
                  <Input id={ids.recipient} value={recipient} maxLength={200} dir="auto" onChange={(e) => setRecipient(e.target.value)} placeholder={t("share.recipientPlaceholder")} aria-describedby={`${ids.recipient}-h`} />
                  <p id={`${ids.recipient}-h`} className="text-meta text-muted-foreground">{t("share.recipientHint")}</p>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={ids.days} className="text-dense font-medium text-foreground">{t("share.days")}</label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id={ids.days}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={SHARE_LINK_MAX_DAYS}
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    dir="ltr"
                    className="w-20 text-center tabular"
                    aria-invalid={!daysOk}
                    aria-describedby={`${ids.days}-h`}
                  />
                  {QUICK_DAYS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={n === d}
                      onClick={() => setDays(String(d))}
                      className={cn("h-7 rounded-sm border px-2 text-meta", n === d ? "border-primary bg-primary/10 text-foreground" : "border-input text-muted-foreground hover:bg-muted")}
                    >
                      {d}
                    </button>
                  ))}
                  {until ? <span className="text-meta text-muted-foreground">{t("share.expiresOn", { date: until })}</span> : null}
                </div>
                <p id={`${ids.days}-h`} className={cn("text-meta", daysOk ? "text-muted-foreground" : "text-destructive")}>
                  {daysOk ? t("share.daysHint") : t("share.daysInvalid")}
                </p>
              </div>
              <label htmlFor={ids.tb} className="inline-flex cursor-pointer items-center gap-2 text-dense text-foreground">
                <input id={ids.tb} type="checkbox" checked={hideTitleBlock} onChange={(e) => setHideTitleBlock(e.target.checked)} className="size-4 accent-[rgb(var(--primary))]" />
                {t("share.hideTitleBlock")}
              </label>
              {hideTitleBlock ? (
                <div className="flex flex-col gap-1 ps-6">
                  <label htmlFor={ids.unm} className="inline-flex cursor-pointer items-center gap-2 text-dense text-foreground">
                    <input id={ids.unm} type="checkbox" checked={includeUnmasked} onChange={(e) => setIncludeUnmasked(e.target.checked)} aria-describedby={`${ids.unm}-h`} className="size-4 accent-[rgb(var(--primary))]" />
                    {t("share.includeUnmasked")}
                  </label>
                  <p id={`${ids.unm}-h`} className={cn("text-meta", includeUnmasked ? "text-conf-low" : "text-muted-foreground")}>{t("share.includeUnmaskedHint")}</p>
                </div>
              ) : null}
              <label htmlFor={ids.pdf} className="inline-flex cursor-pointer items-center gap-2 text-dense text-foreground">
                <input id={ids.pdf} type="checkbox" checked={allowPdf} onChange={(e) => setAllowPdf(e.target.checked)} className="size-4 accent-[rgb(var(--primary))]" />
                {t("share.allowPdf")}
              </label>
              <div>
                <Button type="submit" disabled={create.isPending}>
                  <Link2 aria-hidden />
                  {create.isPending ? t("share.creating") : t("share.create")}
                </Button>
              </div>
            </form>
          )}

          <section aria-labelledby="share-list-title" className="mt-6 flex flex-col gap-2">
            <h3 id="share-list-title" className="text-panel font-bold text-foreground">{t("share.listTitle")}</h3>
            {links.isError ? (
              <p role="alert" className="text-dense text-destructive">{t("share.loadError")}</p>
            ) : links.isLoading ? (
              <p role="status" className="text-dense text-muted-foreground">{t("common.loading")}</p>
            ) : (links.data ?? []).length === 0 ? (
              <p className="text-dense text-muted-foreground">{t("share.listEmpty")}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border" data-share-list>
                {(links.data ?? []).map((l) => (
                  <ShareLinkRow key={l.id} link={l} canManage={canManage} onRevoke={() => setConfirm(l)} />
                ))}
              </ul>
            )}
          </section>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent role="alertdialog" className="max-w-md" aria-describedby="revoke-body">
          <DialogHeader>
            <DialogTitle>{t("share.revokeTitle")}</DialogTitle>
            <DialogDescription id="revoke-body">{t("share.revokeBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="destructive" onClick={() => confirm && void doRevoke(confirm)}>
              <Link2Off aria-hidden />
              {t("share.revoke")}
            </Button>
            <Button variant="secondary" onClick={() => setConfirm(null)} autoFocus>
              {t("share.keep")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ShareLinkRow({ link: l, canManage, onRevoke }: { link: ShareLink; canManage: boolean; onRevoke: () => void }) {
  const { t } = useTranslation();
  const st = linkState(l);
  const chip = {
    active: "border-conf-high/50 bg-conf-high/[0.08] text-foreground",
    expired: "border-border bg-surface-sunken text-muted-foreground",
    revoked: "border-destructive/40 bg-destructive/[0.06] text-foreground",
  }[st];
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 p-3" data-link={l.id} data-state={st}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{l.label || "—"}</span>
          <span className={cn("inline-flex h-5 items-center rounded-sm border px-1.5 text-meta", chip)}>
            {t(st === "active" ? "share.statusActive" : st === "expired" ? "share.statusExpired" : "share.statusRevoked")}
          </span>
          {l.hideTitleBlock ? <span className="text-meta text-muted-foreground">· {t("share.noTitleBlock")}</span> : null}
          {l.allowPdfDownload ? <span className="text-meta text-muted-foreground">· {t("share.pdfAllowed")}</span> : null}
        </div>
        {l.recipient ? (
          <bdi dir="auto" className="text-dense text-muted-foreground">
            {l.recipient}
          </bdi>
        ) : null}
        <p className="flex flex-wrap gap-x-2 text-meta text-muted-foreground">
          <span>
            {st === "revoked" && l.revokedAt
              ? t("share.revokedOn", { date: formatDate(l.revokedAt) })
              : st === "expired"
                ? t("share.expiredOn", { date: formatDate(l.expiresAt) })
                : t("share.until", { date: formatDate(l.expiresAt) })}
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <Eye className="size-3" aria-hidden />
            {l.viewCount ? t("share.views", { count: l.viewCount }) : t("share.notViewed")}
            {l.lastViewedAt ? (
              <>
                {" · "}
                {t("share.lastViewed", { date: "" })}
                <Ltr>{formatDate(l.lastViewedAt)}</Ltr>
              </>
            ) : null}
          </span>
        </p>
      </div>
      {canManage && st === "active" ? (
        <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={onRevoke} aria-label={t("share.revokeFor", { label: l.label })}>
          <Link2Off aria-hidden />
          {t("share.revoke")}
        </Button>
      ) : null}
    </li>
  );
}
