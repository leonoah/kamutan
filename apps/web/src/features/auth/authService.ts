import { initializeApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  isSignInWithEmailLink,
  onIdTokenChanged,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import { env } from "@/lib/env";

export interface AuthSession {
  userId: string;
  email: string;
  accessToken: string;
}

export type AuthErrorCode = "invalid_credentials" | "cancelled" | "generic";

export class AuthError extends Error {
  constructor(public code: AuthErrorCode, message: string = code) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthService {
  getSession(): Promise<AuthSession | null>;
  signInWithPassword(email: string, password: string): Promise<AuthSession>;
  /** Google sign-in popup. */
  signInWithGoogle(): Promise<AuthSession>;
  /** Email-link sign-in. Resolves when the email was sent. */
  sendMagicLink(email: string, redirectTo: string): Promise<void>;
  signOut(): Promise<void>;
  onChange(cb: (session: AuthSession | null) => void): () => void;
}

/* ---------- Firebase ---------- */

const EMAIL_LINK_KEY = "kamutan.emailForSignIn";

function toSession(user: User | null, accessToken: string): AuthSession | null {
  return user ? { userId: user.uid, email: user.email ?? "", accessToken } : null;
}

const INVALID_CREDENTIAL_CODES = new Set([
  "auth/invalid-credential",
  "auth/wrong-password",
  "auth/user-not-found",
  "auth/invalid-email",
]);

function mapError(err: unknown): AuthError {
  const code = (err as { code?: string } | null)?.code ?? "";
  if (INVALID_CREDENTIAL_CODES.has(code)) return new AuthError("invalid_credentials", code);
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    return new AuthError("cancelled", code);
  }
  return new AuthError("generic", code || (err instanceof Error ? err.message : "error"));
}

export function createFirebaseAuth(auth: Auth): AuthService {
  // Completes an email-link (magic link) sign-in when the user lands back on the app.
  const ready: Promise<void> = (async () => {
    if (!isSignInWithEmailLink(auth, window.location.href)) return;
    const email = localStorage.getItem(EMAIL_LINK_KEY);
    if (!email) return; // opened on another device: the user must request a new link
    try {
      await signInWithEmailLink(auth, email, window.location.href);
      localStorage.removeItem(EMAIL_LINK_KEY);
    } catch {
      /* expired / used link: fall through to the login screen */
    }
  })();

  async function current(): Promise<AuthSession | null> {
    await ready;
    await auth.authStateReady();
    const user = auth.currentUser;
    // getIdToken() returns a cached token and refreshes it shortly before expiry.
    return user ? toSession(user, await user.getIdToken()) : null;
  }

  return {
    getSession: current,
    async signInWithPassword(email, password) {
      try {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        return toSession(cred.user, await cred.user.getIdToken()) as AuthSession;
      } catch (err) {
        throw mapError(err);
      }
    },
    async signInWithGoogle() {
      try {
        const cred = await signInWithPopup(auth, new GoogleAuthProvider());
        return toSession(cred.user, await cred.user.getIdToken()) as AuthSession;
      } catch (err) {
        throw mapError(err);
      }
    },
    async sendMagicLink(email, redirectTo) {
      try {
        await sendSignInLinkToEmail(auth, email, { url: redirectTo, handleCodeInApp: true });
        localStorage.setItem(EMAIL_LINK_KEY, email);
      } catch (err) {
        throw mapError(err);
      }
    },
    async signOut() {
      await signOut(auth);
    },
    onChange(cb) {
      return onIdTokenChanged(auth, (user) => {
        if (!user) return cb(null);
        void user.getIdToken().then((token) => cb(toSession(user, token)));
      });
    },
  };
}

/* ---------- Mock (VITE_USE_MOCKS=true, tests) ---------- */

const MOCK_KEY = "kamutan.mock-session";

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
        /* storage unavailable */
      }
    }
    listeners.forEach((l) => l(s));
  };

  return {
    async getSession() {
      return current;
    },
    async signInWithPassword(email, password) {
      await wait();
      // Mirrors SEC-01 minimum password length so demo behaviour matches production rules.
      if (password.length < 10) throw new AuthError("invalid_credentials");
      const s: AuthSession = { userId: `mock-${email}`, email, accessToken: "mock-token" };
      set(s);
      return s;
    },
    async signInWithGoogle() {
      await wait();
      const s: AuthSession = { userId: "mock-google-user", email: "google.user@example.com", accessToken: "mock-token" };
      set(s);
      return s;
    },
    async sendMagicLink() {
      await wait();
    },
    async signOut() {
      set(null);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/* ---------- active instance ---------- */

let active: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!active) {
    active =
      env.useMocks || !env.firebase.apiKey
        ? createMockAuth()
        : createFirebaseAuth(getAuth(initializeApp(env.firebase)));
  }
  return active;
}

/** Test hook / DI seam. */
export function setAuthService(service: AuthService | null) {
  active = service;
}

export async function getAccessToken(): Promise<string | null> {
  return (await getAuthService().getSession())?.accessToken ?? null;
}
