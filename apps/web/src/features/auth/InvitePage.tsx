import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { MailCheck } from "lucide-react";
import { useApi } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { useAuthStore } from "@/stores/authStore";

/**
 * Stage 10 (A-API-01, contracts members.ts): landing of an invitation link `/invite/:inviteId`. The invitation is a
 * pending membership for an email. Signed in → `POST /invites/:id/accept` (the API checks the verified email), then the
 * projects. Signed out → explain and send to sign in (the API also claims it on the first sign-in, via /me).
 */
export function InvitePage() {
  const { t } = useTranslation();
  const { token = "" } = useParams();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const status = useAuthStore((s) => s.status);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (status !== "signedIn" || !token) return;
    let live = true;
    api
      .acceptInvite(token)
      .then(async () => {
        await qc.invalidateQueries({ queryKey: ["me"] });
        if (live) navigate("/projects", { replace: true });
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [status, token, api, qc, navigate]);

  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <Logo />
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-surface p-8 shadow-sm">
        <MailCheck className="size-8 text-primary" aria-hidden />
        <h1 className="text-screen font-bold text-foreground">{t("invite.title")}</h1>
        {status === "signedIn" && !failed ? (
          <p role="status" className="text-body text-muted-foreground">{t("invite.joining")}</p>
        ) : failed ? (
          <>
            <p role="alert" className="text-body text-foreground">{t("invite.failed")}</p>
            <Button asChild variant="secondary">
              <Link to="/projects">{t("invite.toProjects")}</Link>
            </Button>
          </>
        ) : (
          <>
            <p className="text-body text-muted-foreground">{t("invite.body")}</p>
            <Button asChild>
              <Link to="/login">{t("invite.signIn")}</Link>
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
