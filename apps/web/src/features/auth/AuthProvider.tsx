import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/authStore";
import { getAuthService } from "./authService";

/** Hydrates the auth store from the active AuthService and keeps it in sync. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const setSession = useAuthStore((s) => s.setSession);
  useEffect(() => {
    const svc = getAuthService();
    let alive = true;
    void svc.getSession().then((s) => alive && setSession(s));
    const off = svc.onChange((s) => setSession(s));
    return () => {
      alive = false;
      off();
    };
  }, [setSession]);
  return <>{children}</>;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();
  const { t } = useTranslation();
  if (status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground" role="status">
        {t("common.loading")}
      </div>
    );
  }
  if (status === "signedOut") return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
