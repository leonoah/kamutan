import type { ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LogOut, Monitor, Moon, Sun, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Logo } from "./Logo";
import { useAuthStore } from "@/stores/authStore";
import { useThemeStore, type ThemePref } from "@/stores/themeStore";
import { getAuthService } from "@/features/auth/authService";
import { env } from "@/lib/env";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { useOrgStore } from "@/stores/orgStore";
import { cn } from "@/lib/utils";

export function UserMenu() {
  const { t } = useTranslation();
  const session = useAuthStore((s) => s.session);
  const { pref, setPref } = useThemeStore();
  const { org, orgs } = useCurrentOrg();
  const selectOrg = useOrgStore((s) => s.select);
  const initial = (session?.email ?? "?").slice(0, 1).toUpperCase();
  return (
    <DropdownMenu dir="rtl">
      <DropdownMenuTrigger
        className="inline-flex h-9 items-center gap-2 rounded px-1.5 text-dense text-foreground hover:bg-muted"
        aria-label={t("app.userMenu")}
      >
        <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-meta font-bold text-primary">
          {initial}
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          {session?.displayName ? <span className="text-dense text-foreground">{session.displayName}</span> : null}
          <bdi dir="ltr">{session?.email}</bdi>
          {org ? <span className="text-foreground">{org.name}</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {orgs.length > 1 ? (
          <>
            <DropdownMenuLabel>{t("org.switch")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={org?.id ?? ""} onValueChange={(v) => selectOrg(v)}>
              {orgs.map((o) => (
                <DropdownMenuRadioItem key={o.id} value={o.id}>
                  {o.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel>{t("app.theme")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
          <DropdownMenuRadioItem value="system">
            <Monitor aria-hidden /> {t("app.themeSystem")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">
            <Sun aria-hidden /> {t("app.themeLight")}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon aria-hidden /> {t("app.themeDark")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void getAuthService().signOut()}>
          <LogOut aria-hidden className="rtl:-scale-x-100" /> {t("app.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TopBar({ children, className }: { children?: ReactNode; className?: string }) {
  const { t } = useTranslation();
  const { org } = useCurrentOrg();
  return (
    <header className={cn("sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur", className)}>
      <div className="flex h-14 items-center gap-4 px-4 sm:px-6">
        <Link to="/projects" className="rounded" aria-label={t("app.name")}>
          <Logo />
        </Link>
        <nav aria-label={t("app.mainNav")} className="flex items-center gap-1">
          {[
            { to: "/projects", label: t("projects.title") },
            { to: "/library", label: t("library.nav") },
            ...(org?.role === "admin" ? [{ to: "/settings", label: t("settings.nav") }] : []),
          ].map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                cn(
                  "rounded px-2.5 py-1.5 text-dense font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                  isActive && "bg-primary/[0.08] text-foreground",
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
        {env.useMocks ? (
          <span className="hidden rounded-sm border border-dashed border-input px-2 py-0.5 text-meta text-muted-foreground md:inline">
            {t("app.demoMode")}
          </span>
        ) : null}
        <UserMenu />
      </div>
    </header>
  );
}

/** Default shell for list/detail screens. The review workspace renders its own full-bleed chrome. */
export function AppShell() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="skip-link">
        {t("app.skipToContent")}
      </a>
      <TopBar />
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        <Outlet />
      </main>
    </div>
  );
}
