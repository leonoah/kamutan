import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { Providers, makeQueryClient } from "@/App";
import { routes } from "@/routes/router";
import { createMockBackend, type MockOptions } from "@/api/mock";
import { createMockAuth, setAuthService, type AuthService } from "@/features/auth/authService";
import { useAuthStore } from "@/stores/authStore";
import { useOrgStore } from "@/stores/orgStore";
import { useUploadStore } from "@/features/upload/uploadStore";
import { useToastStore } from "@/components/ui/toast";

export interface RenderAppOptions extends MockOptions {
  signedIn?: boolean;
  auth?: AuthService;
}

export async function renderApp(path: string, opts: RenderAppOptions = {}) {
  const auth = opts.auth ?? createMockAuth({ persist: false, latencyMs: 0 });
  if (opts.signedIn) await auth.signInWithPassword("dana@studio.co.il", "correct-horse-battery");
  setAuthService(auth);
  useAuthStore.setState({ status: "loading", session: null });
  useUploadStore.setState({ entries: [] });
  useOrgStore.setState({ selectedOrgId: null });
  useToastStore.setState({ items: [] });

  const backend = createMockBackend({ latencyMs: 0, uploadTickMs: 5, jobTickMs: 5, ...opts });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  let utils!: ReturnType<typeof render>;
  // Flush AuthProvider's async session hydration inside act().
  await act(async () => {
    utils = render(
      <Providers backend={backend} queryClient={makeQueryClient()}>
        <RouterProvider router={router} />
      </Providers>,
    );
  });
  return { ...utils, router, backend, api: backend.api, auth };
}

export function makeFile(name: string, bytes: Uint8Array<ArrayBuffer> | string, type = ""): File {
  const part = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return new File([part], name, { type });
}

export const PDF_BYTES = "%PDF-1.7\n%âãÏÓ\n1 0 obj\n";
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
export const DWG_BYTES = "AC1032\0\0\0\0\0";
export const DXF_BYTES = "  0\nSECTION\n  2\nHEADER\n";
