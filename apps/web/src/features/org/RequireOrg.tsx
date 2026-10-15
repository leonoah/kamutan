import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Building2 } from "lucide-react";
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
  return <>{children}</>;
}
