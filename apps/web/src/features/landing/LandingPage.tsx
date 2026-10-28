import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CheckCheck, ScanSearch, UploadCloud, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { ConfidenceBadge, ConfidenceShape, type ConfidenceLevel } from "@/components/ConfidenceBadge";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/authStore";

/**
 * Public marketing page (docs/spec/05_ux.md: "כל מספר עם קבלה", שפת הביטחון).
 * Mostly a hero plus a short explanation; everything else lives behind /login.
 */
export function LandingPage() {
  const { t } = useTranslation();
  const signedIn = useAuthStore((s) => s.status) === "signedIn";

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="container flex h-14 items-center justify-between">
          <Link to="/" className="rounded" aria-label={t("app.name")}>
            <Logo />
          </Link>
          <Button asChild variant={signedIn ? "primary" : "secondary"} size="sm">
            <Link to={signedIn ? "/projects" : "/login"}>{signedIn ? t("landing.toProjects") : t("landing.login")}</Link>
          </Button>
        </div>
      </header>

      <main id="main" className="flex-1">
        <Hero />
        <HowItWorks />
        <ConfidenceLanguage />
      </main>

      <footer className="border-t border-border">
        <div className="container flex h-14 items-center justify-between text-meta text-muted-foreground">
          <span>{t("landing.footer", { year: new Date().getFullYear() })}</span>
          <Logo withText={false} className="opacity-60" />
        </div>
      </footer>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function Hero() {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden">
      {/* Soft primary glow behind the visual; decorative. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 end-[-10%] h-[520px] w-[520px] rounded-full bg-primary/10 blur-3xl"
      />
      <div className="container grid items-center gap-12 py-16 md:min-h-[80vh] md:py-20 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-16">
        <div className="flex flex-col items-start">
          <h1
            id="hero-title"
            className="text-[40px] font-bold leading-[1.1] tracking-tight text-foreground md:text-[56px]"
          >
            {t("landing.headline")}
            <br />
            <span className="text-primary">{t("landing.tagline")}</span>
          </h1>
          <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-muted-foreground md:text-[19px]">
            {t("landing.lead")}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="px-6">
              <Link to="/login">{t("landing.ctaPrimary")}</Link>
            </Button>
            <Button asChild variant="secondary" size="lg" className="px-6">
              <a href="#how">{t("landing.ctaSecondary")}</a>
            </Button>
          </div>
        </div>
        <HeroVisual />
      </div>
    </section>
  );
}

/** Decorative composition: a drawing sheet on engineering paper, a few confidence markers, and a BOQ card. */
function HeroVisual() {
  const { t } = useTranslation();
  const rows: { level: ConfidenceLevel; code: string; desc: string; qty: string }[] = [
    { level: "high", code: "4.01", desc: t("landing.visual.rows.r1"), qty: "15" },
    { level: "high", code: "4.09", desc: t("landing.visual.rows.r2"), qty: "16" },
    { level: "mid", code: "4.10", desc: t("landing.visual.rows.r3"), qty: "2" },
  ];
  return (
    <div aria-hidden className="relative mx-auto w-full max-w-[560px] select-none pb-20 pe-6 sm:pb-24 sm:pe-10">
      {/* Drawing sheet */}
      <div className="paper-grid relative aspect-[4/3] overflow-hidden rounded-lg border border-border shadow-float">
        {/* Title block (always LTR-ish on real sheets, but here it's just a strip) */}
        <div className="absolute inset-x-0 top-0 flex items-center justify-between border-b border-primary/20 bg-surface/80 px-3 py-1.5 text-meta text-muted-foreground backdrop-blur-sm">
          <span>{t("landing.visual.sheetTitle")}</span>
          <Ltr>{t("landing.visual.sheetMeta")}</Ltr>
        </div>
        <svg viewBox="0 0 400 300" className="absolute inset-0 h-full w-full" focusable="false">
          {/* Walls */}
          <g fill="none" stroke="rgb(var(--primary))" strokeWidth="2.2" strokeLinejoin="round">
            <rect x="48" y="58" width="304" height="200" />
            <path d="M48 150h130M178 58v92M178 190v68M178 150v16M250 150v108M250 58v60M250 150h102" />
          </g>
          {/* Doors */}
          <g fill="none" stroke="rgb(var(--primary))" strokeWidth="1.2" opacity=".7">
            <path d="M178 166a24 24 0 0 1 24 24" />
            <path d="M250 118a24 24 0 0 1-24 24" />
            <path d="M100 150a22 22 0 0 1 22-22" />
          </g>
          {/* Furniture / fixtures */}
          <g fill="none" stroke="rgb(var(--primary))" strokeWidth="1" opacity=".45">
            <rect x="60" y="72" width="54" height="30" rx="2" />
            <rect x="264" y="200" width="70" height="40" rx="2" />
            <circle cx="300" cy="100" r="16" />
            <path d="M60 180h100v60H60z" />
          </g>
          {/* Dimension line */}
          <g stroke="rgb(var(--foreground))" strokeWidth=".8" opacity=".5">
            <path d="M48 276h304M48 272v8M352 272v8" />
          </g>
          {/* Electrical symbols: sockets (circles with a tick) and lights (circle with X) */}
          <g fill="none" stroke="rgb(var(--foreground))" strokeWidth="1.3">
            <circle cx="66" cy="140" r="4.5" />
            <path d="M66 135.5v-7" />
            <circle cx="160" cy="80" r="4.5" />
            <path d="M160 75.5v-7" />
            <circle cx="200" cy="245" r="4.5" />
            <path d="M200 240.5v-7" />
            <circle cx="340" cy="140" r="4.5" />
            <path d="M340 135.5v-7" />
            <circle cx="112" cy="220" r="5" />
            <path d="M108.5 216.5l7 7M115.5 216.5l-7 7" />
            <circle cx="300" cy="190" r="5" />
            <path d="M296.5 186.5l7 7M303.5 186.5l-7 7" />
            <circle cx="214" cy="100" r="5" />
            <path d="M210.5 96.5l7 7M217.5 96.5l-7 7" />
          </g>
          {/* Confidence markers next to symbols: ● verified / ▲ probable / ◆ to review */}
          <g>
            <Marker level="high" x={78} y={128} />
            <Marker level="high" x={172} y={68} />
            <Marker level="high" x={212} y={233} />
            <Marker level="high" x={124} y={208} />
            <Marker level="high" x={312} y={178} />
            <Marker level="mid" x={226} y={88} />
            <Marker level="low" x={352} y={128} />
          </g>
          {/* Room label */}
          <g fill="rgb(var(--muted-foreground))" fontSize="9" fontFamily="inherit" opacity=".8">
            <text x="110" y="120" textAnchor="middle">
              סלון
            </text>
            <text x="214" y="215" textAnchor="middle">
              מטבח
            </text>
            <text x="300" y="150" textAnchor="middle">
              חדר
            </text>
          </g>
        </svg>
      </div>

      {/* BOQ card overlapping the sheet */}
      <div className="absolute bottom-0 start-0 w-[min(100%,340px)] overflow-hidden rounded-lg border border-border bg-surface shadow-float sm:start-[-16px]">
        <div className="flex items-center justify-between border-b border-border bg-surface-sunken px-3 py-2 text-meta text-muted-foreground">
          <span>{t("landing.visual.chapter")}</span>
          <span className="inline-flex items-center gap-1.5">
            <ConfidenceShape level="high" className="size-2.5" />
            {t("landing.visual.verifiedPct", { pct: "91%" })}
          </span>
        </div>
        {rows.map((r) => (
          <div key={r.code} className="flex h-10 items-center gap-3 border-b border-border px-3 text-dense last:border-0">
            <ConfidenceBadge level={r.level} variant="indicator" />
            <Ltr className="w-9 text-muted-foreground">{r.code}</Ltr>
            <span className="flex-1 truncate text-foreground">{r.desc}</span>
            <span className="text-muted-foreground">{t("landing.visual.unit")}</span>
            <Ltr className="w-6 text-end font-medium text-foreground">{r.qty}</Ltr>
          </div>
        ))}
        <div className="border-t border-border bg-surface-sunken/60 px-3 py-1.5 text-meta text-muted-foreground">
          {t("landing.visual.receipt")}
        </div>
      </div>
    </div>
  );
}

const markerColor: Record<ConfidenceLevel, string> = {
  high: "rgb(var(--conf-high))",
  mid: "rgb(var(--conf-mid))",
  low: "rgb(var(--conf-low))",
  unknown: "rgb(var(--conf-unknown))",
  manual: "rgb(var(--manual))",
};

/** Small confidence marker drawn in SVG coordinates (same shapes as ConfidenceShape). */
function Marker({ level, x, y }: { level: ConfidenceLevel; x: number; y: number }) {
  const c = markerColor[level];
  const halo = <circle cx={x} cy={y} r="9" fill={c} opacity=".18" />;
  if (level === "high") {
    return (
      <g>
        {halo}
        <circle cx={x} cy={y} r="5" fill={c} />
        <path
          d={`M${x - 2.4} ${y + 0.2}l1.6 1.6 3.2-3.4`}
          fill="none"
          stroke="rgb(var(--surface))"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    );
  }
  if (level === "mid") {
    return (
      <g>
        {halo}
        <path d={`M${x} ${y - 5.2}l5 9.4h-10z`} fill={c} />
      </g>
    );
  }
  return (
    <g>
      {halo}
      <path d={`M${x} ${y - 5.4}l5.4 5.4-5.4 5.4-5.4-5.4z`} fill={c} />
      <path d={`M${x} ${y - 2.6}v3.2`} stroke="rgb(var(--surface))" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx={x} cy={y + 2.4} r=".8" fill="rgb(var(--surface))" />
    </g>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function HowItWorks() {
  const { t } = useTranslation();
  const steps: { icon: LucideIcon; title: string; body: string }[] = [
    { icon: UploadCloud, title: t("landing.steps.s1Title"), body: t("landing.steps.s1Body") },
    { icon: ScanSearch, title: t("landing.steps.s2Title"), body: t("landing.steps.s2Body") },
    { icon: CheckCheck, title: t("landing.steps.s3Title"), body: t("landing.steps.s3Body") },
  ];
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-16 border-t border-border bg-surface-sunken/50">
      <div className="container py-16 md:py-20">
        <h2 id="how-title" className="text-screen text-foreground md:text-hero">
          {t("landing.howTitle")}
        </h2>
        <ol className="mt-8 grid gap-4 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className="flex flex-col rounded-lg border border-border bg-surface p-6 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-10 items-center justify-center rounded bg-primary/10 text-primary">
                  <s.icon className="size-5" aria-hidden />
                </span>
                <span className="text-meta font-medium text-muted-foreground">
                  <Ltr>{String(i + 1).padStart(2, "0")}</Ltr>
                </span>
              </div>
              <h3 className="mt-4 text-panel text-foreground">{s.title}</h3>
              <p className="mt-2 text-body text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function ConfidenceLanguage() {
  const { t } = useTranslation();
  const levels: ConfidenceLevel[] = ["high", "mid", "low"];
  return (
    <section aria-labelledby="conf-title" className="border-t border-border">
      <div className="container py-16 md:py-20">
        <h2 id="conf-title" className="text-screen text-foreground md:text-hero">
          {t("landing.confTitle")}
        </h2>
        <p className="mt-3 max-w-2xl text-body text-muted-foreground">{t("landing.confLead")}</p>
        <ul className="mt-8 grid gap-3 sm:grid-cols-3">
          {levels.map((level) => (
            <li
              key={level}
              className={cn("flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3", "text-body text-foreground")}
            >
              <ConfidenceBadge level={level} />
              <span className="text-muted-foreground">{t(`landing.conf.${level}`)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
