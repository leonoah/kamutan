import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { KeyRound, MailCheck, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Logo } from "@/components/Logo";
import { ConfidenceBadge } from "@/components/ConfidenceBadge";
import { Ltr } from "@/components/Ltr";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/authStore";
import { AuthError, MOCK_EMAIL_LINK, getAuthService } from "./authService";

export function authErrorText(err: unknown, t: (k: string) => string): string {
  if (!(err instanceof AuthError)) return t("auth.errorGeneric");
  switch (err.code) {
    case "invalid_credentials":
      return t("auth.errorInvalid");
    case "too_many_requests":
      return t("auth.errorTooMany");
    case "user_disabled":
      return t("auth.errorDisabled");
    case "popup_closed":
      return t("auth.errorPopup");
    case "invalid_link":
      return t("auth.completeInvalid");
    default:
      return t("auth.errorGeneric");
  }
}

type Mode = "password" | "magic";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const status = useAuthStore((s) => s.status);
  const from = (location.state as { from?: string } | null)?.from ?? "/projects";

  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (status === "signedIn") return <Navigate to={from} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    const trimmed = email.trim();
    if (!trimmed) next.email = t("auth.errorRequired");
    else if (!EMAIL_RE.test(trimmed)) next.email = t("auth.errorEmail");
    if (mode === "password" && !password) next.password = t("auth.errorPasswordRequired");
    setErrors(next);
    if (Object.keys(next).length) return;

    setSubmitting(true);
    try {
      const auth = getAuthService();
      if (mode === "password") {
        await auth.signInWithPassword(trimmed, password);
        navigate(from, { replace: true });
      } else {
        await auth.sendMagicLink(trimmed);
        setSentTo(trimmed);
      }
    } catch (err) {
      setErrors({ form: authErrorText(err, t) });
    } finally {
      setSubmitting(false);
    }
  }

  async function onGoogle() {
    setErrors({});
    setSubmitting(true);
    try {
      await getAuthService().signInWithGoogle();
      navigate(from, { replace: true });
    } catch (err) {
      setErrors({ form: authErrorText(err, t) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <main id="main" className="flex flex-col px-6 py-8 sm:px-12">
        <Logo />
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <h1 className="text-hero text-foreground">{t("auth.title")}</h1>
          <p className="mt-2 text-body text-muted-foreground">{t("auth.subtitle")}</p>

          <div
            role="group"
            aria-label={t("auth.modeLabel")}
            className="mt-8 grid grid-cols-2 gap-1 rounded border border-border bg-surface-sunken p-1"
          >
            {(["password", "magic"] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => {
                  setMode(m);
                  setErrors({});
                  setSentTo(null);
                }}
                className={cn(
                  "inline-flex h-8 items-center justify-center gap-1.5 rounded-sm text-dense font-medium transition-colors",
                  mode === m ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "password" ? <KeyRound className="size-3.5" aria-hidden /> : <Mail className="size-3.5" aria-hidden />}
                {m === "password" ? t("auth.modePassword") : t("auth.modeMagic")}
              </button>
            ))}
          </div>

          {sentTo ? (
            <div role="status" className="mt-6 flex items-start gap-3 rounded border border-conf-high/30 bg-conf-high/[0.06] p-4">
              <MailCheck className="mt-0.5 size-5 shrink-0 text-conf-high" aria-hidden />
              <div className="flex flex-col gap-2">
                <p className="text-body text-foreground">{t("auth.magicSent", { email: `⁨${sentTo}⁩` })}</p>
                {env.useMocks ? (
                  <p className="text-meta text-muted-foreground">
                    {t("auth.mockLinkHint")}{" "}
                    <Link to={MOCK_EMAIL_LINK} className="font-medium text-primary hover:underline">
                      {t("auth.mockLinkOpen")}
                    </Link>
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <form onSubmit={onSubmit} noValidate className="mt-6 flex flex-col gap-4" aria-label={t("auth.title")}>
              <Field id="email" label={t("auth.email")} error={errors.email}>
                <Input
                  id="email"
                  type="email"
                  dir="ltr"
                  className="text-start"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? "email-error" : undefined}
                  required
                />
              </Field>
              {mode === "password" ? (
                <Field id="password" label={t("auth.password")} error={errors.password}>
                  <Input
                    id="password"
                    type="password"
                    dir="ltr"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={!!errors.password}
                    aria-describedby={errors.password ? "password-error" : undefined}
                    required
                  />
                </Field>
              ) : null}
              {errors.form ? (
                <p role="alert" className="rounded border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-dense text-destructive">
                  {errors.form}
                </p>
              ) : null}
              <Button type="submit" size="lg" disabled={submitting} className="mt-2">
                {submitting ? t("auth.submitting") : mode === "password" ? t("auth.submit") : t("auth.magicSubmit")}
              </Button>
              {env.useMocks && mode === "password" ? (
                <p className="text-meta text-muted-foreground">{t("auth.mockHint")}</p>
              ) : null}
            </form>
          )}

          <div className="my-6 flex items-center gap-3 text-meta text-muted-foreground">
            <span aria-hidden className="h-px flex-1 bg-border" />
            {t("auth.or")}
            <span aria-hidden className="h-px flex-1 bg-border" />
          </div>
          <Button variant="secondary" size="lg" onClick={() => void onGoogle()} disabled={submitting}>
            <GoogleMark />
            {t("auth.google")}
          </Button>
        </div>
        <p className="text-meta text-muted-foreground">{t("auth.footer")}</p>
      </main>
      <LoginVisual />
    </div>
  );
}

/** Google "G" mark (brand colours, never mirrored). */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden focusable="false" className="size-4">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

/** Decorative: a calm "receipt" excerpt of a BOQ on engineering paper. Hidden from AT. */
function LoginVisual() {
  const { t } = useTranslation();
  const rows = [
    { level: "high" as const, code: "4.01", desc: "שקע כפול", qty: "15" },
    { level: "high" as const, code: "4.09", desc: "נק' מאור", qty: "16" },
    { level: "mid" as const, code: "4.10", desc: "נק' מאור בעלת שני מחליפים", qty: "2" },
    { level: "low" as const, code: "4.11", desc: "שתי נק' מאור משותפות", qty: "5" },
  ];
  return (
    <aside aria-hidden className="paper-grid relative hidden overflow-hidden border-s border-border lg:block">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background/60" />
      <div className="relative flex h-full flex-col justify-center px-16">
        <p className="max-w-md text-[22px] font-medium leading-snug text-foreground">{t("app.tagline")}</p>
        <div className="mt-8 max-w-md overflow-hidden rounded-lg border border-border bg-surface shadow-float">
          <div className="flex items-center justify-between border-b border-border bg-surface-sunken px-4 py-2 text-meta text-muted-foreground">
            <span>פרק 04 – עבודות חשמל</span>
            <span>
              <Ltr>91%</Ltr> מאומת
            </span>
          </div>
          {rows.map((r) => (
            <div key={r.code} className="flex h-10 items-center gap-3 border-b border-border px-4 text-dense last:border-0">
              <ConfidenceBadge level={r.level} variant="indicator" />
              <Ltr className="w-9 text-muted-foreground">{r.code}</Ltr>
              <span className="flex-1 truncate text-foreground">{r.desc}</span>
              <span className="text-muted-foreground">יח'</span>
              <Ltr className="w-6 text-end font-medium text-foreground">{r.qty}</Ltr>
            </div>
          ))}
        </div>
        <p className="mt-4 text-meta text-muted-foreground">16 = 14 מזוהים + 2 ידניים · 3 גיליונות</p>
      </div>
    </aside>
  );
}
