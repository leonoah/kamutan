import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

export interface AuthSession {
  userId: string;
  email: string;
  accessToken: string;
}

export type AuthErrorCode = "invalid_credentials" | "generic";

export class AuthError extends Error {
  constructor(public code: AuthErrorCode, message: string = code) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthService {
  getSession(): Promise<AuthSession | null>;
  signInWithPassword(email: string, password: string): Promise<AuthSession>;
  /** Supabase magic link (OTP by email). Resolves when the email was sent. */
  sendMagicLink(email: string, redirectTo: string): Promise<void>;
  signOut(): Promise<void>;
  onChange(cb: (session: AuthSession | null) => void): () => void;
}

/* ---------- Supabase ---------- */

export function createSupabaseAuth(client: SupabaseClient): AuthService {
  const toSession = (s: { access_token: string; user: { id: string; email?: string } } | null): AuthSession | null =>
    s ? { userId: s.user.id, email: s.user.email ?? "", accessToken: s.access_token } : null;

  return {
    async getSession() {
      const { data } = await client.auth.getSession();
      return toSession(data.session);
    },
    async signInWithPassword(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) {
        throw new AuthError(error.status === 400 ? "invalid_credentials" : "generic", error.message);
      }
      const s = toSession(data.session);
      if (!s) throw new AuthError("generic", "No session returned");
      return s;
    },
    async sendMagicLink(email, redirectTo) {
      const { error } = await client.auth.signInWithOtp({
        email,
        // Invite-only orgs (SEC-01): never auto-create users from the login screen.
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
      });
      if (error) throw new AuthError("generic", error.message);
    },
    async signOut() {
      await client.auth.signOut();
    },
    onChange(cb) {
      const { data } = client.auth.onAuthStateChange((_event, session) => cb(toSession(session)));
      return () => data.subscription.unsubscribe();
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
      env.useMocks || !env.supabaseUrl
        ? createMockAuth()
        : createSupabaseAuth(
            createClient(env.supabaseUrl, env.supabaseAnonKey, {
              auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
            }),
          );
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
