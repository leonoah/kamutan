import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted fonts (CSP: font-src 'self'; no Google Fonts). Only the Hebrew + Latin subsets
// (unicode-range keeps unused ones from downloading anyway; this also keeps dist small).
import "@fontsource/heebo/hebrew-400.css";
import "@fontsource/heebo/hebrew-500.css";
import "@fontsource/heebo/hebrew-700.css";
import "@fontsource/heebo/latin-400.css";
import "@fontsource/heebo/latin-500.css";
import "@fontsource/heebo/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "./styles/index.css";
import { applyDocumentDirection } from "./i18n";
import { applyTheme, useThemeStore } from "./stores/themeStore";
import { App } from "./App";
import { createBackend } from "./api/client";

applyDocumentDirection();
applyTheme(useThemeStore.getState().pref);

// Sprint 8: the backend module is chosen before the first render (mock mode loads the mock chunk; real mode never does).
void createBackend().then((backend) =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App backend={backend} />
    </StrictMode>,
  ),
);
