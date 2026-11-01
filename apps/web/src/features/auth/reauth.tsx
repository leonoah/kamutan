import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, ShieldAlert } from "lucide-react";
import { ApiError } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { getAuthService, hasRecentLogin } from "./authService";

/** API codes that mean "sign in again" (auth_time older than 10 min / MFA claim missing). */
export const isReauthError = (e: unknown) =>
  e instanceof ApiError && (e.status === 401 || e.status === 403) && /recent|reauth|auth_time|stale/i.test(e.code);
/** API `mfa_required`: a fresh sign-in does not help without a second factor. */
export const isMfaError = (e: unknown) => e instanceof ApiError && e.status === 403 && /mfa/i.test(e.code);

type Action = () => unknown;

/**
 * Stage 10 (A-API-02): admin changes (org settings, templates, rules, members) need MFA + a sign-in from the last 10
 * minutes, like offboarding. `guard(action)` runs the action at once when the sign-in is recent, else shows the
 * re-authentication box and runs it after a successful re-authentication. `handle(error, retry)` maps the API's
 * `recent_auth_required` / `mfa_required` answers onto the same box. Render `element` where the box should appear.
 */
export function useReauthGate(): {
  guard: (action: Action) => Promise<void>;
  handle: (error: unknown, retry: Action) => boolean;
  element: ReactNode;
  pending: boolean;
} {
  const pendingRef = useRef<Action | null>(null);
  const [pending, setPending] = useState(false);
  const [mfa, setMfa] = useState(false);
  const ask = useCallback((a: Action) => {
    pendingRef.current = a;
    setPending(true);
    setMfa(false);
  }, []);
  const guard = useCallback(
    async (action: Action) => {
      if (await hasRecentLogin(getAuthService())) action();
      else ask(action);
    },
    [ask],
  );
  const handle = useCallback(
    (e: unknown, retry: Action) => {
      if (isMfaError(e)) {
        setMfa(true);
        return true;
      }
      if (isReauthError(e)) {
        ask(retry);
        return true;
      }
      return false;
    },
    [ask],
  );
  const done = useCallback(() => {
    const a = pendingRef.current;
    pendingRef.current = null;
    setPending(false);
    a?.();
  }, []);
  const cancel = useCallback(() => {
    pendingRef.current = null;
    setPending(false);
  }, []);
  const element = mfa ? (
    <MfaNotice onClose={() => setMfa(false)} />
  ) : pending ? (
    <ReauthBox onDone={done} onCancel={cancel} />
  ) : null;
  return { guard, handle, element, pending };
}

function MfaNotice({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-conf-low/40 bg-conf-low/[0.06] p-3 text-dense text-foreground" data-mfa-required>
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-conf-low" aria-hidden />
      <p className="flex-1">{t("offboarding.mfaRequired")}</p>
      <Button size="sm" variant="ghost" onClick={onClose}>
        {t("common.close")}
      </Button>
    </div>
  );
}

/** The offboarding re-authentication box (Google popup / password / "sign in again"), reusable. */
export function ReauthBox({ onDone, onCancel, body }: { onDone: () => void; onCancel?: () => void; body?: string }) {
  const { t } = useTranslation();
  const pwId = useId();
  const titleId = useId();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const method = getAuthService().reauthMethod();
  const run = async () => {
    setBusy(true);
    setErr(false);
    try {
      await getAuthService().reauthenticate(method === "password" ? password : undefined);
      setPassword("");
      toast({ title: t("offboarding.reauthDone"), tone: "success" });
      onDone();
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="alertdialog" aria-labelledby={titleId} className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4" data-reauth>
      <p id={titleId} className="flex items-center gap-2 font-bold text-foreground">
        <KeyRound className="size-4" aria-hidden />
        {t("offboarding.reauthTitle")}
      </p>
      <p className="text-dense text-muted-foreground">{body ?? t("reauth.adminBody")}</p>
      {method === "signin" ? (
        <p className="text-dense text-foreground">{t("offboarding.reauthSignin")}</p>
      ) : method === "google" ? (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void run()} disabled={busy}>
            {t("offboarding.reauthGoogle")}
          </Button>
          {onCancel ? (
            <Button variant="ghost" onClick={onCancel}>
              {t("reauth.cancel")}
            </Button>
          ) : null}
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={pwId} className="text-meta text-muted-foreground">
              {t("offboarding.reauthPassword")}
            </label>
            <Input id={pwId} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-64 max-w-full" />
          </div>
          <Button type="submit" variant="secondary" disabled={busy || !password}>
            {t("offboarding.reauthSubmit")}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("reauth.cancel")}
            </Button>
          ) : null}
        </form>
      )}
      {err ? (
        <p role="alert" className="text-meta text-destructive">
          {t("offboarding.reauthFailed")}
        </p>
      ) : null}
    </div>
  );
}
