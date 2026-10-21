import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, Download, KeyRound, PackageOpen } from "lucide-react";
import { useApi } from "@/api/client";
import { ApiError } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { getAuthService, hasRecentLogin } from "@/features/auth/authService";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { formatDate, formatDateTime } from "@/lib/format";

/** API codes that mean "sign in again" (auth_time older than 10 min / MFA claim missing). */
export const isReauthError = (e: unknown) =>
  e instanceof ApiError && (e.status === 401 || e.status === 403) && /recent|reauth|auth_time|stale/i.test(e.code);
/** API `mfa_required`: a fresh sign-in does not help without a second factor. */
export const isMfaError = (e: unknown) => e instanceof ApiError && e.status === 403 && /mfa/i.test(e.code);

/** contracts OffboardOrgRequest: the confirmation is the org name, exact after trim. */
export const confirmTextOf = (org: { name: string }) => org.name;

/**
 * SEC-52 offboarding (admin): 1) full ZIP export (sources, BOQ xlsx per project, JSON) with a 24 h link; 2) offboard
 * with clear Hebrew warnings, the org slug typed to confirm, an explicit acknowledgement and a sign-in from the last
 * 10 minutes (re-authenticates through Firebase when `auth_time` is too old).
 */
export function OffboardingPage({ pollMs = 700 }: { pollMs?: number }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const { org } = useCurrentOrg();
  const ids = { confirm: useId(), ack: useId(), pw: useId() };
  const [exportId, setExportId] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [typed, setTyped] = useState("");
  const [ack, setAck] = useState(false);
  const [reauth, setReauth] = useState(false);
  const [password, setPassword] = useState("");
  const [reauthBusy, setReauthBusy] = useState(false);
  const [reauthErr, setReauthErr] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [mfa, setMfa] = useState(false);

  const startExport = useMutation({
    mutationFn: () => api.startOffboardingExport(org!.id),
    onSuccess: (x) => setExportId(x.id),
    onError: (e) => {
      if (isMfaError(e)) setMfa(true);
      else if (isReauthError(e)) setReauth(true);
      else toast({ title: t("offboarding.exportError"), tone: "error" });
    },
  });
  const exp = useQuery({
    queryKey: ["offboarding-export", org?.id, exportId],
    queryFn: () => api.getOffboardingExport(org!.id, exportId!),
    enabled: Boolean(org && exportId),
    refetchInterval: (q) => (q.state.data?.status === "succeeded" || q.state.data?.status === "failed" ? false : pollMs),
  });
  const offboard = useMutation({ mutationFn: () => api.offboardOrg(org!.id, { confirm: typed.trim() }) });

  useEffect(() => {
    if (org?.status === "offboarding" && org.deleteAfter) setDone(org.deleteAfter);
  }, [org?.status, org?.deleteAfter]);

  if (!org) return null;
  const slug = confirmTextOf(org);
  const matches = typed.trim() === slug;
  const x = exp.data;
  const method = getAuthService().reauthMethod();

  const submit = async () => {
    if (!matches || !ack) return;
    if (!(await hasRecentLogin(getAuthService()))) {
      setReauth(true);
      return;
    }
    try {
      const r = await offboard.mutateAsync();
      setDone(r.deleteAfter);
      void qc.invalidateQueries({ queryKey: ["me"] });
    } catch (e) {
      if (isMfaError(e)) setMfa(true);
      else if (isReauthError(e)) setReauth(true);
      else toast({ title: t("offboarding.error"), tone: "error" });
    }
  };
  const doReauth = async () => {
    setReauthBusy(true);
    setReauthErr(false);
    try {
      await getAuthService().reauthenticate(method === "password" ? password : undefined);
      setReauth(false);
      setPassword("");
      toast({ title: t("offboarding.reauthDone"), tone: "success" });
      await submit();
    } catch {
      setReauthErr(true);
    } finally {
      setReauthBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5" data-offboarding>
      <div className="flex flex-col gap-1">
        <h2 className="text-panel font-bold text-foreground">{t("offboarding.title")}</h2>
        <p className="text-body text-muted-foreground">{t("offboarding.intro", { org: org.name })}</p>
      </div>

      {mfa ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/[0.06] p-3 text-dense text-foreground" data-mfa-required>
          {t("offboarding.mfaRequired")}
        </p>
      ) : null}
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5" aria-labelledby="ob-step1">
        <h3 id="ob-step1" className="flex items-center gap-2 text-body font-bold text-foreground">
          <PackageOpen className="size-4" aria-hidden />
          {t("offboarding.step1")}
        </h3>
        <p className="text-dense text-muted-foreground">{t("offboarding.step1Body")}</p>
        {x?.status === "succeeded" && x.url ? (
          <div role="status" className="flex flex-wrap items-center gap-3">
            <span className="font-medium text-foreground">{t("offboarding.exportReady")}</span>
            <Button asChild>
              <a href={x.url} download="kamutan-export.zip" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={() => setDownloaded(true)}>
                <Download aria-hidden />
                {t("offboarding.download")}
              </a>
            </Button>
            {x.expiresAt ? <span className="text-meta text-muted-foreground">{t("offboarding.exportExpires", { date: formatDateTime(x.expiresAt) })}</span> : null}
          </div>
        ) : x?.status === "failed" ? (
          <div className="flex items-center gap-3">
            <p role="alert" className="text-dense text-destructive">{t("offboarding.exportError")}</p>
            <Button variant="secondary" onClick={() => startExport.mutate()}>{t("offboarding.exportStart")}</Button>
          </div>
        ) : exportId ? (
          <div role="status" aria-live="polite" className="flex flex-col gap-1.5">
            <span className="text-dense text-foreground">{t("offboarding.exportRunning", { pct: x?.progress ?? 0 })}</span>
            <Progress value={x?.progress ?? 0} aria-label={t("offboarding.exportRunning", { pct: x?.progress ?? 0 })} />
          </div>
        ) : (
          <div>
            <Button variant="secondary" onClick={() => startExport.mutate()} disabled={startExport.isPending}>
              <PackageOpen aria-hidden />
              {t("offboarding.exportStart")}
            </Button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/[0.04] p-5" aria-labelledby="ob-step2">
        <h3 id="ob-step2" className="flex items-center gap-2 text-body font-bold text-foreground">
          <AlertOctagon className="size-4 text-destructive" aria-hidden />
          {t("offboarding.step2")}
        </h3>
        {done ? (
          <p role="status" className="font-medium text-foreground" data-offboarded>
            {t("offboarding.done", { date: formatDate(done) })}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5" role="note" aria-label={t("offboarding.warnTitle")}>
              <p className="font-bold text-foreground">{t("offboarding.warnTitle")}</p>
              <ul className="list-disc space-y-1 ps-5 text-dense text-foreground">
                <li>{t("offboarding.warn1")}</li>
                <li>{t("offboarding.warn2")}</li>
                <li className="font-medium">{t("offboarding.warn3")}</li>
                <li>{t("offboarding.warn4")}</li>
              </ul>
            </div>
            {!downloaded ? <p className="rounded-sm border border-conf-mid/40 bg-conf-mid/[0.08] px-3 py-2 text-dense text-foreground">{t("offboarding.exportFirst")}</p> : null}
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.confirm} className="text-dense text-foreground">
                {t("offboarding.confirmLabel")}: <bdi className="font-bold">{slug}</bdi>
              </label>
              <Input
                id={ids.confirm}
                dir="auto"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-invalid={typed.length > 0 && !matches}
                aria-describedby={typed.length > 0 && !matches ? `${ids.confirm}-e` : undefined}
                className="max-w-sm"
              />
              {typed.length > 0 && !matches ? <p id={`${ids.confirm}-e`} className="text-meta text-destructive">{t("offboarding.confirmMismatch")}</p> : null}
            </div>
            <label htmlFor={ids.ack} className="inline-flex cursor-pointer items-start gap-2 text-dense text-foreground">
              <input id={ids.ack} type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-[rgb(var(--destructive))]" />
              {t("offboarding.understand")}
            </label>

            {reauth ? (
              <div role="alertdialog" aria-labelledby="ob-reauth" className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4" data-reauth>
                <p id="ob-reauth" className="flex items-center gap-2 font-bold text-foreground">
                  <KeyRound className="size-4" aria-hidden />
                  {t("offboarding.reauthTitle")}
                </p>
                <p className="text-dense text-muted-foreground">{t("offboarding.reauthBody")}</p>
                {method === "signin" ? (
                  <p className="text-dense text-foreground">{t("offboarding.reauthSignin")}</p>
                ) : method === "google" ? (
                  <div>
                    <Button variant="secondary" onClick={() => void doReauth()} disabled={reauthBusy}>
                      {t("offboarding.reauthGoogle")}
                    </Button>
                  </div>
                ) : (
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void doReauth();
                    }}
                  >
                    <div className="flex flex-col gap-1">
                      <label htmlFor={ids.pw} className="text-meta text-muted-foreground">{t("offboarding.reauthPassword")}</label>
                      <Input id={ids.pw} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-64" />
                    </div>
                    <Button type="submit" variant="secondary" disabled={reauthBusy || !password}>
                      {t("offboarding.reauthSubmit")}
                    </Button>
                  </form>
                )}
                {reauthErr ? <p role="alert" className="text-meta text-destructive">{t("offboarding.reauthFailed")}</p> : null}
              </div>
            ) : null}

            <div>
              <Button variant="destructive" onClick={() => void submit()} disabled={!matches || !ack || offboard.isPending || reauth}>
                {offboard.isPending ? t("offboarding.submitting") : t("offboarding.submit")}
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
