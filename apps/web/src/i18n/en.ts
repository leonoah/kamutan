import type { Resources } from "./he";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** English scaffold — partial on purpose; missing keys fall back to Hebrew. */
const en: DeepPartial<Resources> = {
  app: { name: "Kamutan", tagline: "Bills of quantities from drawing sets — with a receipt for every number", skipToContent: "Skip to main content", logout: "Log out" },
  confidence: { high: "Verified", mid: "Likely", low: "Needs review", unknown: "Unknown", manual: "Manually approved" },
  auth: { title: "Sign in to Kamutan", email: "Email", password: "Password", submit: "Sign in" },
  projects: { title: "Projects", newProject: "New project", emptyTitle: "No projects yet.", emptyBody: "Drop a drawing set here and we'll get started." },
};

export default en;
