import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http";
import { ApiError } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("REST client", () => {
  it("calls same-origin /api/v1 with the Firebase ID token as Bearer", async () => {
    const fetchImpl = vi.fn(async () => json({ items: [], nextCursor: null }));
    const api = createHttpClient(async () => "id-token", "/api/v1", fetchImpl as unknown as typeof fetch);
    await api.listProjects("org 1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/projects?orgId=org%201&limit=100");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer id-token");
  });

  it("posts upload + finalize to the contract endpoints", async () => {
    const fetchImpl = vi.fn(async () => json({}, 201));
    const api = createHttpClient(async () => "t", "/api/v1", fetchImpl as unknown as typeof fetch);
    await api.createUpload("p1", { filename: "a.pdf", sizeBytes: 10 });
    await api.finalizeUpload("p1", { uploadToken: "tok-tok-tok-tok-tok", name: "a.pdf" });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u, i]) => [u, i.method, JSON.parse(i.body as string)])).toEqual([
      ["/api/v1/projects/p1/uploads", "POST", { filename: "a.pdf", sizeBytes: 10 }],
      ["/api/v1/projects/p1/sheet-sets", "POST", { uploadToken: "tok-tok-tok-tok-tok", name: "a.pdf" }],
    ]);
  });

  it("omits Authorization when signed out and maps the contract error body", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { code: "upload_expired", message: "expired", requestId: "r-1" } }, 410),
    );
    const api = createHttpClient(async () => null, "/api/v1", fetchImpl as unknown as typeof fetch);
    const err = await api.getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 410, code: "upload_expired", requestId: "r-1" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("Sprint 2: overlay, legend entries (list/patch) and unknown-cluster resolve hit the contract endpoints", async () => {
    const fetchImpl = vi.fn(async () => json({ items: [], nextCursor: null, expiresAt: null }));
    const api = createHttpClient(async () => "t", "/api/v1", fetchImpl as unknown as typeof fetch);
    await api.getOverlay("p1", "s 1", "v1");
    await api.listLegendEntries("p1", { sheetId: "s1", limit: 200 });
    await api.patchLegendEntry("p1", "le_s1_1", { action: "reassign", class: "socket_power" });
    await api.resolveUnknownCluster("p1", "u_1", { sheetId: "s1", versionId: "v1", class: "data_point", createLegendEntry: true });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u, i]) => [u, i.method ?? "GET", i.body ? JSON.parse(i.body as string) : null])).toEqual([
      ["/api/v1/projects/p1/sheets/s%201/versions/v1/overlay", "GET", null],
      ["/api/v1/projects/p1/legend-entries?sheetId=s1&limit=200", "GET", null],
      ["/api/v1/projects/p1/legend-entries/le_s1_1", "PATCH", { action: "reassign", class: "socket_power" }],
      ["/api/v1/projects/p1/unknown-clusters/u_1/resolve", "POST", { sheetId: "s1", versionId: "v1", class: "data_point", createLegendEntry: true }],
    ]);
  });
});
