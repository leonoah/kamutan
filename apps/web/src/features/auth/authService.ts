import {
  GoogleAuthProvider,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import { env } from "@/lib/env";
import { getFirebase } from "@/lib/firebase";

export interface AuthSession {
  uid: string;
  email: string;
  displayName: string | null;
}

export type AuthErrorCode =
  | "invalid_credentials"
  | "invalid_link"
  | "popup_closed"
  | "too_many_requests"
  | "user_disabled"
  | "generic";

export class AuthError extends Error {
  constructor(
    public code: AuthErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthService {
  getSession(): AuthSession | null;
  signInWithPassword(email: string, password: string): Promise<AuthSession>;
  /** Sends a Firebase email sign-in link that lands on /auth/complete. */
  sendMagicLink(email: string): Promise<void>;
  isEmailLink(url: string): boolean;
  /** Completes an email-link sign-in. `email` falls back to the one stored when the link was sent. */
  completeEmailLink(url: string, email?: string): Promise<AuthSession>;
  /** Email remembered on this device when the link was requested (null on another device). */
  storedEmailForLink(): string | null;
  signInWithGoogle(): Promise<AuthSession>;
  signOut(): Promise<void>;
  /** Fires immediately with the current state (like onAuthStateChanged), then on every change. */
  onChange(cb: (session: AuthSession | null) => void): () => void;
  /** Fresh Firebase ID token for `Authorization: Bearer` (null when signed out). */
  getIdToken(): Promise<string | null>;
}

export const EMAIL_FOR_SIGN_IN_KEY = "kamutan.emailForSignIn";
export const AUTH_COMPLETE_PATH = "/auth/complete";

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

/* ---------------- Firebase ---------------- */

const toSession = (u: User | null): AuthSession | null =>
  u ? { uid: u.uid, email: u.email ?? "", displayName: u.displayName } : null;

/** Maps Firebase Auth error codes (auth/...) to UI codes. Never leaks whether an account exists. */
export function mapFirebaseAuthError(err: unknown): AuthError {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-email":
    case "auth/invalid-login-credentials":
      return new AuthError("invalid_credentials", code);
    case "auth/invalid-action-code":
    case "auth/expired-action-code":
      return new AuthError("invalid_link", code);
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
    case "auth/popup-blocked":
      return new AuthError("popup_closed", code);
    case "auth/too-many-requests":
      return new AuthError("too_many_requests", code);
    case "auth/user-disabled":
      return new AuthError("user_disabled", code);
    default:
      return new AuthError("generic", code || String(err));
  }
}

export function createFirebaseAuth(auth: Auth, origin = window.location.origin): AuthService {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw e instanceof AuthError ? e : mapFirebaseAuthError(e);
    }
  };

  return {
    getSession: () => toSession(auth.currentUser),
    signInWithPassword: (email, password) =>
      wrap(async () => toSession((await signInWithEmailAndPassword(auth, email, password)).user)!),
    sendMagicLink: (email) =>
      wrap(async () => {
        await sendSignInLinkToEmail(auth, email, { url: `${origin}${AUTH_COMPLETE_PATH}`, handleCodeInApp: true });
        store.set(EMAIL_FOR_SIGN_IN_KEY, email);
      }),
    isEmailLink: (url) => isSignInWithEmailLink(auth, url),
    storedEmailForLink: () => store.get(EMAIL_FOR_SIGN_IN_KEY),
    completeEmailLink: (url, email) =>
      wrap(async () => {
        if (!isSignInWithEmailLink(auth, url)) throw new AuthError("invalid_link");
        const addr = email ?? store.get(EMAIL_FOR_SIGN_IN_KEY);
        if (!addr) throw new AuthError("invalid_link", "missing email");
        const cred = await signInWithEmailLink(auth, addr, url);
        store.set(EMAIL_FOR_SIGN_IN_KEY, null);
        return toSession(cred.user)!;
      }),
    signInWithGoogle: () =>
      wrap(async () => {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        return toSession((await signInWithPopup(auth, provider)).user)!;
      }),
    signOut: () => signOut(auth),
    onChange: (cb) => onAuthStateChanged(auth, (u) => cb(toSession(u))),
    getIdToken: async () => (auth.currentUser ? auth.currentUser.getIdToken() : null),
  };
}

/* ---------------- Mock (VITE_USE_MOCKS=true, tests) ---------------- */

const MOCK_KEY = "kamutan.mock-session";
export const MOCK_EMAIL_LINK = "/auth/complete?mode=signIn&oobCode=mock-oob-code";

export function createMockAuth(opts: { persist?: boolean; latencyMs?: number } = {}): AuthService {
  const persist = opts.persist ?? true;
  const latency = opts.latencyMs ?? 300;
  const listeners = new Set<(s: AuthSession | null) => void>();
  let current: AuthSession | null = null;
  if (persist) {
    try {
      const raw = sessionStorage.getItem(MOCK_KEY);
      current = raw ? (JSON.parse(raw) as AuthSession) : null;
    } catch {
      current = null;
    }
  }
  const wait = () => (latency > 0 ? new Promise((r) => setTimeout(r, latency)) : Promise.resolve());
  const set = (s: AuthSession | null) => {
    current = s;
    if (persist) {
      try {
        if (s) sessionStorage.setItem(MOCK_KEY, JSON.stringify(s));
        else sessionStorage.removeItem(MOCK_KEY);
      } catch {
        /* ignore */
      }
    }
    listeners.forEach((l) => l(s));
  };
  const sessionFor = (email: string, displayName: string | null = null): AuthSession => ({
    uid: `mock-${email.replace(/[^A-Za-z0-9]/g, "_")}`,
    email,
    displayName,
  });

  return {
    getSession: () => current,
    async signInWithPassword(email, password) {
      await wait();
      // Mirrors SEC-01 minimum password length so demo behaviour matches production rules.
      if (password.length < 10) throw new AuthError("invalid_credentials");
      const s = sessionFor(email);
      set(s);
      return s;
    },
    async sendMagicLink(email) {
      await wait();
      store.set(EMAIL_FOR_SIGN_IN_KEY, email);
    },
    isEmailLink: (url) => /[?&]oobCode=/.test(url) && /[?&]mode=signIn/.test(url),
    storedEmailForLink: () => store.get(EMAIL_FOR_SIGN_IN_KEY),
    async completeEmailLink(url, email) {
      await wait();
      if (!/oobCode=mock-oob-code/.test(url)) throw new AuthError("invalid_link");
      const addr = email ?? store.get(EMAIL_FOR_SIGN_IN_KEY);
      if (!addr) throw new AuthError("invalid_link", "missing email");
      store.set(EMAIL_FOR_SIGN_IN_KEY, null);
      const s = sessionFor(addr);
      set(s);
      return s;
    },
    async signInWithGoogle() {
      await wait();
      const s = sessionFor("demo.user@gmail.com", "משתמשת הדגמה");
      set(s);
      return s;
    },
    async signOut() {
      set(null);
    },
    onChange(cb) {
      listeners.add(cb);
      queueMicrotask(() => listeners.has(cb) && cb(current));
      return () => listeners.delete(cb);
    },
    getIdToken: async () => (current ? `mock-id-token.${current.uid}` : null),
  };
}

/* ---------------- active instance ---------------- */

let active: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!active) active = env.useMocks ? createMockAuth() : createFirebaseAuth(getFirebase().auth);
  return active;
}

/** Test hook / DI seam. */
export function setAuthService(service: AuthService | null) {
  active = service;
}

export async function getIdToken(): Promise<string | null> {
  return getAuthService().getIdToken();
}
