import type { ComponentType } from "react";
import { createBrowserRouter, Outlet, type RouteObject } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { NavigationProgress, RouteLoading } from "@/components/RouteLoading";
import { AuthProvider, RequireAuth } from "@/features/auth/AuthProvider";
import { LoginPage } from "@/features/auth/LoginPage";
import { CompleteEmailLinkPage } from "@/features/auth/CompleteEmailLinkPage";
import { RequireOrg } from "@/features/org/RequireOrg";
import { NotFoundPage } from "./NotFoundPage";

/**
 * Sprint 8 — code-splitting: every screen is a lazy route (its own chunk). The shell (auth, org, top bar) and the
 * login stay in the entry chunk; the review workspace + drawing viewer (deck.gl, ~900 kB) are only fetched by the
 * review / sheet-analysis routes, so the landing, the projects list and the hub never load them.
 * First load of a lazy route shows <RouteLoading/> (HydrateFallback); in-app navigations keep the current screen and
 * show the top progress bar (AppShell → NavigationProgress).
 */
const page = (load: () => Promise<{ Component: ComponentType }>): Pick<RouteObject, "lazy" | "HydrateFallback"> => ({
  lazy: load,
  HydrateFallback: () => <RouteLoading />,
});
const fullPage = (load: () => Promise<{ Component: ComponentType }>): Pick<RouteObject, "lazy" | "HydrateFallback"> => ({
  lazy: load,
  HydrateFallback: () => <RouteLoading variant="full" />,
});

export const routes: RouteObject[] = [
  // Sprint 5: external read-only share viewer — OUTSIDE AuthProvider (no Firebase Auth, no member API).
  {
    path: "/s/:token",
    ...fullPage(async () => ({ Component: (await import("@/features/share/SharedViewerPage")).SharedViewerPage })),
  },
  {
    element: (
      <AuthProvider>
        <NavigationProgress />
        <Outlet />
      </AuthProvider>
    ),
    HydrateFallback: () => <RouteLoading variant="full" />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/auth/complete", element: <CompleteEmailLinkPage /> },
      { path: "/invite/:token", ...fullPage(async () => ({ Component: (await import("@/features/auth/InvitePage")).InvitePage })) },
      {
        element: (
          <RequireAuth>
            <RequireOrg>
              <Outlet />
            </RequireOrg>
          </RequireAuth>
        ),
        children: [
          {
            element: <AppShell />,
            children: [
              { path: "/projects", ...page(async () => ({ Component: (await import("@/features/projects/ProjectsPage")).ProjectsPage })) },
              { path: "/projects/:projectId", ...page(async () => ({ Component: (await import("@/features/projects/ProjectPage")).ProjectPage })) },
              { path: "/projects/:projectId/settings", ...page(async () => ({ Component: (await import("@/features/projects/ProjectSettingsPage")).ProjectSettingsPage })) },
              { path: "/projects/:projectId/sheets", ...page(async () => ({ Component: (await import("@/features/sheets/SheetsPage")).SheetsPage })) },
              { path: "/projects/:projectId/legend", ...page(async () => ({ Component: (await import("@/features/legend/LegendPage")).LegendPage })) },
              // Sprint 7: the BOQ as the Excel will look (print CSS: A4 portrait, no app chrome).
              { path: "/projects/:projectId/boq/preview", ...page(async () => ({ Component: (await import("@/features/boq/BoqPreviewPage")).BoqPreviewPage })) },
              // Sprint 8: "מה השתנה" between two BOQ builds.
              { path: "/projects/:projectId/boq/compare", ...page(async () => ({ Component: (await import("@/features/compare/ComparePage")).ComparePage })) },
              { path: "/library", ...page(async () => ({ Component: (await import("@/features/library/LibraryPage")).LibraryPage })) },
              {
                path: "/settings",
                ...page(async () => ({ Component: (await import("@/features/settings/SettingsLayout")).SettingsLayout })),
                children: [
                  { index: true, ...page(async () => ({ Component: (await import("@/features/settings/OrgSettingsPage")).OrgSettingsPage })) },
                  { path: "members", ...page(async () => ({ Component: (await import("@/features/settings/MembersPage")).MembersPage })) },
                  { path: "audit", ...page(async () => ({ Component: (await import("@/features/settings/AuditLogPage")).AuditLogPage })) },
                  { path: "offboarding", ...page(async () => ({ Component: (await import("@/features/settings/OffboardingPage")).OffboardingPage })) },
                ],
              },
            ],
          },
          // Review workspace has its own full-bleed chrome; it pulls in the drawing viewer (deck.gl).
          { path: "/projects/:projectId/review", ...fullPage(async () => ({ Component: (await import("@/features/review/ReviewPage")).ReviewPage })) },
          // Sheet analysis: the same workspace locked to one sheet (IA level 3).
          { path: "/projects/:projectId/sheets/:sheetId", ...fullPage(async () => ({ Component: (await import("@/features/review/ReviewPage")).ReviewPage })) },
        ],
      },
      { path: "/", ...fullPage(async () => ({ Component: (await import("@/features/landing/LandingPage")).LandingPage })) },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
