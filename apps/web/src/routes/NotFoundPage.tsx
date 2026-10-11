import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-3">
      <h1 className="text-screen text-foreground">{t("common.notFound")}</h1>
      <Link to="/projects" className="text-primary hover:underline">{t("common.home")}</Link>
    </main>
  );
}
