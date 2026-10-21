import { beforeEach, describe, expect, it, vi } from "vitest";

const fa = vi.hoisted(() => ({
  signInWithEmailAndPassword: vi.fn(),
  sendSignInLinkToEmail: vi.fn(),
  isSignInWithEmailLink: vi.fn(),
  signInWithEmailLink: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  setCustomParameters: vi.fn(),
  getIdTokenResult: vi.fn(),
  reauthenticateWithPopup: vi.fn(),
  reauthenticateWithCredential: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  ...fa,
  // Vitest 4: an implementation called with `new` must be a function/class, not an arrow.
  GoogleAuthProvider: vi.fn().mockImplementation(function () {
    return { providerId: "google.com", setCustomParameters: fa.setCustomParameters };
  }),
  EmailAuthProvider: { credential: vi.fn((email: string, password: string) => ({ email, password })) },
}));

import { AuthError, EMAIL_FOR_SIGN_IN_KEY, createFirebaseAuth, mapFirebaseAuthError } from "./authService";
import type { Auth } from "firebase/auth";

const user = { uid: "u1", email: "dana@studio.co.il", displayName: "דנה", getIdToken: vi.fn(async () => "id-token-123") };
const authState: { currentUser: typeof user | null } = { currentUser: null };
const auth = authState as unknown as Auth;
const svc = createFirebaseAuth(auth, "https://app.kamutan.test");

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  authState.currentUser = null;
});

describe("Firebase AuthService", () => {
  it("email + password maps the user to a session", async () => {
    fa.signInWithEmailAndPassword.mockResolvedValue({ user });
    await expect(svc.signInWithPassword("dana@studio.co.il", "secret-secret")).resolves.toEqual({
      uid: "u1",
      email: "dana@studio.co.il",
      displayName: "דנה",
    });
    expect(fa.signInWithEmailAndPassword).toHaveBeenCalledWith(auth, "dana@studio.co.il", "secret-secret");
  });

  it("maps Firebase error codes without revealing whether the account exists", async () => {
    fa.signInWithEmailAndPassword.mockRejectedValue({ code: "auth/user-not-found" });
    await expect(svc.signInWithPassword("x@y.co", "whatever-123")).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(mapFirebaseAuthError({ code: "auth/wrong-password" }).code).toBe("invalid_credentials");
    expect(mapFirebaseAuthError({ code: "auth/too-many-requests" }).code).toBe("too_many_requests");
    expect(mapFirebaseAuthError({ code: "auth/expired-action-code" }).code).toBe("invalid_link");
    expect(mapFirebaseAuthError({ code: "auth/popup-closed-by-user" }).code).toBe("popup_closed");
    expect(mapFirebaseAuthError(new Error("boom"))).toBeInstanceOf(AuthError);
  });

  it("sends the email link to /auth/complete (handleCodeInApp) and remembers the email", async () => {
    fa.sendSignInLinkToEmail.mockResolvedValue(undefined);
    await svc.sendMagicLink("dana@studio.co.il");
    expect(fa.sendSignInLinkToEmail).toHaveBeenCalledWith(auth, "dana@studio.co.il", {
      url: "https://app.kamutan.test/auth/complete",
      handleCodeInApp: true,
    });
    expect(localStorage.getItem(EMAIL_FOR_SIGN_IN_KEY)).toBe("dana@studio.co.il");
  });

  it("completes the email link with the stored email and then forgets it", async () => {
    localStorage.setItem(EMAIL_FOR_SIGN_IN_KEY, "dana@studio.co.il");
    fa.isSignInWithEmailLink.mockReturnValue(true);
    fa.signInWithEmailLink.mockResolvedValue({ user });
    const link = "https://app.kamutan.test/auth/complete?mode=signIn&oobCode=abc";
    await expect(svc.completeEmailLink(link)).resolves.toMatchObject({ uid: "u1" });
    expect(fa.signInWithEmailLink).toHaveBeenCalledWith(auth, "dana@studio.co.il", link);
    expect(localStorage.getItem(EMAIL_FOR_SIGN_IN_KEY)).toBeNull();
  });

  it("refuses to complete without an email (other device) or with a non-link URL", async () => {
    fa.isSignInWithEmailLink.mockReturnValue(true);
    await expect(svc.completeEmailLink("https://x/auth/complete?oobCode=a")).rejects.toMatchObject({ code: "invalid_link" });
    fa.isSignInWithEmailLink.mockReturnValue(false);
    await expect(svc.completeEmailLink("https://x/", "a@b.co")).rejects.toMatchObject({ code: "invalid_link" });
    expect(fa.signInWithEmailLink).not.toHaveBeenCalled();
  });

  it("Google sign-in uses a popup with account selection", async () => {
    fa.signInWithPopup.mockResolvedValue({ user });
    await expect(svc.signInWithGoogle()).resolves.toMatchObject({ uid: "u1" });
    expect(fa.setCustomParameters).toHaveBeenCalledWith({ prompt: "select_account" });
    expect(fa.signInWithPopup).toHaveBeenCalledWith(auth, expect.objectContaining({ providerId: "google.com" }));
  });

  it("session store is driven by onAuthStateChanged", () => {
    const cb = vi.fn();
    const off = vi.fn();
    fa.onAuthStateChanged.mockImplementation((_a, listener: (u: unknown) => void) => {
      listener(user);
      listener(null);
      return off;
    });
    expect(svc.onChange(cb)).toBe(off);
    expect(cb.mock.calls).toEqual([[{ uid: "u1", email: "dana@studio.co.il", displayName: "דנה" }], [null]]);
  });

  it("returns a fresh ID token for the Bearer header (null when signed out)", async () => {
    await expect(svc.getIdToken()).resolves.toBeNull();
    authState.currentUser = user;
    await expect(svc.getIdToken()).resolves.toBe("id-token-123");
  });

  describe("Sprint 5: recent login", () => {
    const u = (providerId: string) => ({ ...user, providerData: [{ providerId }], getIdToken: vi.fn(async () => "fresh") });

    it("reads auth_time from the ID token result", async () => {
      await expect(svc.getAuthTime()).resolves.toBeNull();
      authState.currentUser = u("password") as never;
      fa.getIdTokenResult.mockResolvedValue({ authTime: "Thu, 15 Oct 2026 10:00:00 GMT" });
      await expect(svc.getAuthTime()).resolves.toBe(Date.parse("2026-10-15T10:00:00Z"));
    });

    it("re-authenticates Google users with a popup and forces a fresh token", async () => {
      const g = u("google.com");
      authState.currentUser = g as never;
      expect(svc.reauthMethod()).toBe("google");
      await svc.reauthenticate();
      expect(fa.reauthenticateWithPopup).toHaveBeenCalledWith(g, expect.objectContaining({ providerId: "google.com" }));
      expect(g.getIdToken).toHaveBeenCalledWith(true);
    });

    it("re-authenticates password users with a credential; refuses without a password", async () => {
      const p = u("password");
      authState.currentUser = p as never;
      expect(svc.reauthMethod()).toBe("password");
      await expect(svc.reauthenticate()).rejects.toMatchObject({ code: "invalid_credentials" });
      await svc.reauthenticate("correct-horse-battery");
      expect(fa.reauthenticateWithCredential).toHaveBeenCalledWith(p, { email: "dana@studio.co.il", password: "correct-horse-battery" });
      expect(p.getIdToken).toHaveBeenCalledWith(true);
    });

    it("email-link-only users are asked to sign in again", () => {
      authState.currentUser = u("emailLink") as never;
      expect(svc.reauthMethod()).toBe("signin");
    });
  });
});
