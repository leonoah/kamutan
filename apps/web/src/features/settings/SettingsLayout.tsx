import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";

/** S14 shell: admin-only tabs (מדיניות · יומן פעולות · סיום התקשרות). Non-admins get a calm explanation. */
export function SettingsLayout() {
  const { t } = useTranslation();
  const { org } = useCurrentOrg();
  if (!org) return null;
  if (org.role !== "admin") {
    return <EmptyState title={t("settings.title")} body={t("settings.adminOnly")} illustration={<ShieldAlert className="size-8 text-muted-foreground" aria-hidden />} />;
  }
  const tabs = [
    { to: "/settings", end: true, label: t("settings.tabGeneral") },
    { to: "/settings/audit", end: false, label: t("settings.tabAudit") },
    { to: "/settings/offboarding", end: false, label: t("settings.tabOffboarding") },
  ];
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-screen font-bold text-foreground">{t("settings.title")}</h1>
        <p className="text-body text-muted-foreground">{t("settings.subtitle", { org: org.name })}</p>
      </div>
      <nav aria-label={t("settings.tabsLabel")} className="flex gap-1 border-b border-border">
        {tabs.map((x) => (
          <NavLink
            key={x.to}
            to={x.to}
            end={x.end}
            className={({ isActive }) =>
              cn(
                "relative px-3 py-2 text-dense font-medium text-muted-foreground hover:text-foreground",
                isActive && "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
              )
            }
          >
            {x.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
