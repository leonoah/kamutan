import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/authStore";
import { useUploadStore } from "@/features/upload/uploadStore";
import { getAuthService } from "./authService";

/** Session store is driven by AuthService.onChange (Firebase onAuthStateChanged). */
export function AuthProvider({ children }: { children: ReactNode }) {
  const setSession = useAuthStore((s) => s.setSession);
  const qc = useQueryClient();
  useEffect(() => {
    let prevUid: string | null | undefined;
    return getAuthService().onChange((s) => {
      const uid = s?.uid ?? null;
      // User switched or signed out: never leak cached tenant data or in-flight uploads to the next user.
      if (prevUid !== undefined && prevUid !== uid) {
        qc.clear();
        for (const e of useUploadStore.getState().entries) useUploadStore.getState().remove(e.id);
      }
      prevUid = uid;
      setSession(s);
    });
  }, [setSession, qc]);
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
