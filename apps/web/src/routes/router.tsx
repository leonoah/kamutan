import { createBrowserRouter, Navigate, Outlet, type RouteObject } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { AuthProvider, RequireAuth } from "@/features/auth/AuthProvider";
import { LoginPage } from "@/features/auth/LoginPage";
import { CompleteEmailLinkPage } from "@/features/auth/CompleteEmailLinkPage";
import { RequireOrg } from "@/features/org/RequireOrg";
import { ProjectsPage } from "@/features/projects/ProjectsPage";
import { ProjectPage } from "@/features/projects/ProjectPage";
import { SheetsPage } from "@/features/sheets/SheetsPage";
import { LegendPage } from "@/features/legend/LegendPage";
import { LibraryPage } from "@/features/library/LibraryPage";
import { NotFoundPage } from "./NotFoundPage";

export const routes: RouteObject[] = [
  // Sprint 5: external read-only share viewer — OUTSIDE AuthProvider (no Firebase Auth, no member API).
  {
    path: "/s/:token",
    lazy: async () => ({ Component: (await import("@/features/share/SharedViewerPage")).SharedViewerPage }),
  },
  {
    element: (
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    ),
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/auth/complete", element: <CompleteEmailLinkPage /> },
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
              { path: "/projects", element: <ProjectsPage /> },
              { path: "/projects/:projectId", element: <ProjectPage /> },
              { path: "/projects/:projectId/sheets", element: <SheetsPage /> },
              { path: "/projects/:projectId/legend", element: <LegendPage /> },
              { path: "/library", element: <LibraryPage /> },
              {
                path: "/settings",
                lazy: async () => ({ Component: (await import("@/features/settings/SettingsLayout")).SettingsLayout }),
                children: [
                  { index: true, lazy: async () => ({ Component: (await import("@/features/settings/OrgSettingsPage")).OrgSettingsPage }) },
                  { path: "audit", lazy: async () => ({ Component: (await import("@/features/settings/AuditLogPage")).AuditLogPage }) },
                  { path: "offboarding", lazy: async () => ({ Component: (await import("@/features/settings/OffboardingPage")).OffboardingPage }) },
                ],
              },
            ],
          },
          // Review workspace has its own full-bleed chrome
          // Lazy route: the review workspace pulls in the drawing viewer (Deck.gl) — keep it out of the main chunk.
          {
            path: "/projects/:projectId/review",
            lazy: async () => ({ Component: (await import("@/features/review/ReviewPage")).ReviewPage }),
          },
        ],
      },
      { path: "/", element: <Navigate to="/projects" replace /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
