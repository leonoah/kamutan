import { screen, waitFor, within } from "@testing-library/react";
import type { DrawingViewerProps } from "@kamutan/viewer";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";

vi.mock("@kamutan/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kamutan/viewer")>();
  return {
    ...actual,
    DrawingViewer: (p: DrawingViewerProps) => <div role="application" aria-label={p.ariaLabel} dir="ltr" data-overlays={p?.overlays?.length ?? 0} />,
  };
});

const LAZY = { timeout: 20_000 };
const fast = { signedIn: true, devIndex: false, boqTickMs: 1, jobTickMs: 1 } as const;

describe("Sprint 9 UI — input-quality gate", { timeout: 40_000 }, () => {
  beforeAll(async () => {
    await Promise.all([import("@/features/projects/ProjectPage"), import("@/features/review/ReviewPage"), import("@/features/sheets/SheetsPage")]);
  });

  it("hub: warn tile has a badge + issue, reject tile shows no counts; processing panel lists both with what to do; axe", async () => {
    const { container } = await renderApp("/projects/p-web", fast);
    const gallery = await screen.findByRole("list", { name: "שרטוטים" }, LAZY);
    const warn = await within(gallery).findByRole("article", { name: "חשמל — צילום מסך מהאינטרנט" });
    const reject = within(gallery).getByRole("article", { name: "הריסה — חיתוך הפוך" });
    expect(warn).toHaveAttribute("data-quality", "warn");
    expect(reject).toHaveAttribute("data-quality", "reject");
    await waitFor(() => expect(within(warn).getByText(/^\d+ פריטים$/)).toBeInTheDocument());
    expect(within(warn).getByText("צילום מסך ולא קובץ שרטוט")).toBeInTheDocument();
    expect(within(reject).getByText("לא נספרו פריטים")).toBeInTheDocument();
    expect(within(reject).queryByText(/^\d+ פריטים$/)).toBeNull();
    expect(within(reject).getByText("רזולוציה נמוכה מדי (כ-30 dpi)")).toBeInTheDocument();
    expect(within(reject).getByText("הקובץ הפוך (מראה)")).toBeInTheDocument();

    const section = container.querySelector("[data-quality-section]") as HTMLElement;
    expect(section).toBeTruthy();
    expect(within(section).getByText(/2 גיליונות עם בעיית איכות/)).toBeInTheDocument();
    const rejRow = section.querySelector('[data-quality-row="web-crop-p0"]') as HTMLElement;
    expect(within(rejRow).getByText(/העלה את הגיליון המלא, כולל המסגרת וטבלת הכותרת/)).toBeInTheDocument();
    expect(within(rejRow).getAllByText(/העלה את קובץ ה-PDF המקורי מתוכנת השרטוט/).length).toBeGreaterThan(0);
    expect(within(rejRow).getByRole("button", { name: /העלה קובץ מקורי במקום/ })).toBeInTheDocument();
    expect(within(rejRow).getByRole("link", { name: "הריסה — חיתוך הפוך" })).toHaveAttribute("href", "/projects/p-web/sheets/web-crop-p0");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("viewer role: no upload button in the quality list", async () => {
    const { container } = await renderApp("/projects/p-web", { ...fast, orgs: [{ id: "org-demo", name: "x", role: "viewer" }] });
    await screen.findByRole("list", { name: "שרטוטים" }, LAZY);
    await waitFor(() => expect(container.querySelector("[data-quality-section]")).toBeTruthy());
    expect(within(container.querySelector("[data-quality-section]") as HTMLElement).queryByRole("button", { name: /העלה קובץ מקורי/ })).toBeNull();
  });

  it("sheet analysis of a rejected sheet: banner with what to do, drawing shown, counts tab says not counted; axe", async () => {
    const { container } = await renderApp("/projects/p-web/sheets/web-crop-p0", fast);
    const banner = await waitFor(() => {
      const el = container.querySelector('[data-quality-banner="reject"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    }, LAZY);
    expect(banner).toHaveTextContent("לא ספרנו פריטים בגיליון הזה, כי איכות הקובץ נמוכה מדי. השרטוט מוצג לעיון בלבד.");
    expect(within(banner).getByText("רזולוציה נמוכה מדי (כ-30 dpi)")).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: /העלה קובץ מקורי במקום הריסה — חיתוך הפוך/ })).toBeInTheDocument();
    expect(await screen.findByRole("application", {}, LAZY)).toBeInTheDocument();
    const counts = await waitFor(() => {
      const el = container.querySelector("[data-counts-rejected]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(counts).toHaveTextContent("לא נספרו פריטים");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("sheet analysis of a warn sheet: warn banner, items counted and carry the quality reason", async () => {
    const { container } = await renderApp("/projects/p-web/sheets/web-shot-p0", fast);
    await waitFor(() => expect(container.querySelector('[data-quality-banner="warn"]')).toBeTruthy(), LAZY);
    expect(container.querySelector('[data-quality-banner="warn"]')).toHaveTextContent('כולם מסומנים לבדיקה ולא יסומנו "מאומת"');
    await waitFor(() => expect(Number(screen.getByRole("application").getAttribute("data-overlays"))).toBeGreaterThan(10), LAZY);
    expect(container.querySelector("[data-counts-rejected]")).toBeNull();
    // the queue shows the items with the quality reason chip
    await waitFor(() => expect(container.querySelector('[data-reason="INPUT_QUALITY"]')).toBeTruthy(), LAZY);
    expect(container.querySelector('[data-reason="INPUT_QUALITY"]')).toHaveTextContent("איכות קובץ ירודה");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("confirm-sheets page: cards carry the quality badge + issues", async () => {
    const { container } = await renderApp("/projects/p-web/sheets", fast);
    await waitFor(() => expect(container.querySelector('[data-card-quality="reject"]')).toBeTruthy(), LAZY);
    expect(container.querySelector('[data-card-quality="warn"]')).toHaveTextContent("איכות ירודה");
  });
});
