import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import he from "./he";
import en from "./en";

export const DEFAULT_LANG = "he";
export const RTL_LANGS = new Set(["he", "ar"]);

void i18n.use(initReactI18next).init({
  resources: { he: { translation: he }, en: { translation: en } },
  lng: DEFAULT_LANG,
  fallbackLng: DEFAULT_LANG,
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** Keep <html dir/lang> in sync with the active language (index.html ships dir="rtl" lang="he"). */
export function applyDocumentDirection(lang: string = i18n.language) {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = RTL_LANGS.has(lang) ? "rtl" : "ltr";
}

i18n.on("languageChanged", (lng) => applyDocumentDirection(lng));

export default i18n;
