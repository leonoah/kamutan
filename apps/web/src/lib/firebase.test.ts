import { describe, expect, it, vi } from "vitest";

const an = vi.hoisted(() => ({ getAnalytics: vi.fn(), isSupported: vi.fn(async () => true) }));
vi.mock("firebase/analytics", () => an);

import { getFirebase, maybeStartAnalytics } from "./firebase";
import type { FirebaseApp } from "firebase/app";

describe("firebase bootstrap", () => {
  it("analytics stays off without consent (default)", async () => {
    await expect(maybeStartAnalytics({} as FirebaseApp)).resolves.toBe(false);
    await expect(maybeStartAnalytics({} as FirebaseApp, false)).resolves.toBe(false);
    expect(an.getAnalytics).not.toHaveBeenCalled();
  });

  it("refuses to initialize when VITE_FIREBASE_* are missing (tests/mock mode)", () => {
    expect(() => getFirebase()).toThrow(/not configured/);
  });
});
