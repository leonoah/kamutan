import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Logo } from "@/components/Logo";
import { getAuthService } from "./authService";
import { authErrorText } from "./LoginPage";

type State = { kind: "working" } | { kind: "askEmail" } | { kind: "error"; message: string };

/**
 * /auth/complete — landing route of the Firebase email sign-in link
 * (actionCodeSettings.url, handleCodeInApp). Same device: email comes from localStorage.
 * Other device: we ask for it again (Firebase requirement, prevents session fixation).
 */
export function CompleteEmailLinkPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "working" });
  const [email, setEmail] = useState("");
  const started = useRef(false);
  const location = useLocation();
  // Router location (== window.location in the browser; also correct under a memory router).
  const href = `${window.location.origin}${location.pathname}${location.search}`;

  async function complete(addr?: string) {
    setState({ kind: "working" });
    try {
      await getAuthService().completeEmailLink(href, addr);
      // Drop the one-time code from history before moving on.
      navigate("/projects", { replace: true });
    } catch (err) {
      setState({ kind: "error", message: authErrorText(err, t) });
    }
  }

  useEffect(() => {
    if (started.current) return; // StrictMode double-invoke: the oobCode is single-use
    started.current = true;
    const auth = getAuthService();
    if (!auth.isEmailLink(href)) setState({ kind: "error", message: t("auth.completeInvalid") });
    else if (!auth.storedEmailForLink()) setState({ kind: "askEmail" });
    else void complete();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (email.trim()) void complete(email.trim());
  }

  return (
    <main id="main" className="flex min-h-dvh flex-col px-6 py-8 sm:px-12">
      <Logo />
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4">
        <h1 className="text-screen text-foreground">{t("auth.title")}</h1>
        {state.kind === "working" ? (
          <p role="status" className="text-body text-muted-foreground">
            {t("auth.completeTitle")}
          </p>
        ) : state.kind === "askEmail" ? (
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4" aria-label={t("auth.completeSubmit")}>
            <p className="text-body text-muted-foreground">{t("auth.completeAskEmail")}</p>
            <Field id="link-email" label={t("auth.email")}>
              <Input
                id="link-email"
                type="email"
                dir="ltr"
                className="text-start"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" size="lg">
              {t("auth.completeSubmit")}
            </Button>
          </form>
        ) : (
          <>
            <p role="alert" className="rounded border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-dense text-destructive">
              {state.message}
            </p>
            <Link to="/login" className="text-dense font-medium text-primary hover:underline">
              {t("auth.completeBack")}
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
