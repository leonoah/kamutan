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
});
