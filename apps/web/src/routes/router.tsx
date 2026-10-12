import { createBrowserRouter, Navigate, Outlet, type RouteObject } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { AuthProvider, RequireAuth } from "@/features/auth/AuthProvider";
import { LoginPage } from "@/features/auth/LoginPage";
import { CompleteEmailLinkPage } from "@/features/auth/CompleteEmailLinkPage";
import { RequireOrg } from "@/features/org/RequireOrg";
import { ProjectsPage } from "@/features/projects/ProjectsPage";
import { ProjectPage } from "@/features/projects/ProjectPage";
import { ReviewPage } from "@/features/review/ReviewPage";
import { NotFoundPage } from "./NotFoundPage";

export const routes: RouteObject[] = [
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
            ],
          },
          // Review workspace has its own full-bleed chrome
          { path: "/projects/:projectId/review", element: <ReviewPage /> },
        ],
      },
      { path: "/", element: <Navigate to="/projects" replace /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
