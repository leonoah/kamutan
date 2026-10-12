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
}));

vi.mock("firebase/auth", () => ({
  ...fa,
  GoogleAuthProvider: vi.fn().mockImplementation(() => ({ providerId: "google.com", setCustomParameters: fa.setCustomParameters })),
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
});
