import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Building2, ShieldOff } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { getAuthService } from "@/features/auth/authService";
import { useAuthStore } from "@/stores/authStore";
import { useCurrentOrg } from "./useCurrentOrg";

/** Resolves the current org from GET /api/v1/me; members-only app (orgs are invite-only). */
export function RequireOrg({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { org, isLoading, isError, refetch } = useCurrentOrg();
  const email = useAuthStore((s) => s.session?.email ?? "");
  const { pathname } = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground" role="status">
        {t("common.loading")}
      </div>
    );
  }
  if (isError) {
    return (
      <main id="main" className="flex min-h-dvh items-center justify-center p-6">
        <div role="alert" className="flex flex-col items-center gap-3 text-center">
          <p className="text-body text-foreground">{t("org.loadError")}</p>
          <Button variant="secondary" size="sm" onClick={refetch}>
            {t("projects.retry")}
          </Button>
        </div>
      </main>
    );
  }
  if (!org) {
    return (
      <main id="main" className="flex min-h-dvh items-center justify-center p-6">
        <EmptyState
          illustration={
            <span className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Building2 className="size-7" aria-hidden />
            </span>
          }
          title={t("org.noneTitle")}
          body={t("org.noneBody", { email: `⁨${email}⁩` })}
          action={
            <Button variant="secondary" onClick={() => void getAuthService().signOut()}>
              {t("app.logout")}
            </Button>
          }
        />
      </main>
    );
  }
  // SEC-52: an offboarding org is blocked except the admin's export download (/settings/offboarding).
  if (org.status === "offboarding" && !(org.role === "admin" && pathname.startsWith("/settings/offboarding"))) {
    return (
      <main id="main" className="flex min-h-dvh items-center justify-center p-6" data-org-offboarding>
        <EmptyState
          illustration={<ShieldOff className="size-8 text-destructive" aria-hidden />}
          title={t("offboarding.blockedTitle")}
          body={
            <>
              {t("offboarding.blockedBody", { date: org.deleteAfter ? formatDate(org.deleteAfter) : "—" })}
              {org.role === "admin" ? <span className="mt-1 block">{t("offboarding.blockedDownload")}</span> : null}
            </>
          }
          action={
            <div className="flex gap-2">
              {org.role === "admin" ? (
                <Button asChild>
                  <Link to="/settings/offboarding">{t("offboarding.download")}</Link>
                </Button>
              ) : null}
              <Button variant="secondary" onClick={() => void getAuthService().signOut()}>
                {t("app.logout")}
              </Button>
            </div>
          }
        />
      </main>
    );
  }
  return <>{children}</>;
}
