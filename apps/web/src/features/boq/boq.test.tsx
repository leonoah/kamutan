import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DrawingViewerProps, MarkerFeature, PathFeature, PolygonFeature } from "@kamutan/viewer";
import { axe } from "@/test/axe";
import { renderApp, type RenderAppOptions } from "@/test/utils";
import { useToastStore } from "@/components/ui/toast";

const seen: { props: DrawingViewerProps | null } = { props: null };
// Generous waits (not test timeouts): under a parallel turbo run jsdom renders are several times slower.
const LAZY = { timeout: 25_000 };
// Load the lazy route chunks (review workspace + deck.gl viewer) once, outside the per-test budget.
beforeAll(async () => {
  await import("@/features/review/ReviewPage");
  await import("@/features/viewer/SheetViewer");
}, 60_000);
vi.mock("@kamutan/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kamutan/viewer")>();
  return {
    ...actual,
    DrawingViewer: (p: DrawingViewerProps) => {
      seen.props = p;
      return <div role="application" aria-label={p.ariaLabel} dir="ltr" />;
    },
  };
});

const markers = () => (seen.props?.overlays ?? []).filter((f): f is MarkerFeature => f.kind === "marker");
const paths = () => (seen.props?.overlays ?? []).filter((f): f is PathFeature => f.kind === "path");
const hulls = () => (seen.props?.overlays ?? []).filter((f): f is PolygonFeature => f.kind === "polygon" && f.id.startsWith("lg-hull-"));
const toasts = () => useToastStore.getState().items.map((t) => t.title);
const row = (code: string) => document.querySelector<HTMLTableRowElement>(`tr[data-code="${code}"]`)!;
const COMPOSITE = ["4.11", "4.16", "4.10", "4.09"];

async function open(opts: RenderAppOptions = {}, path = "/projects/p-noah/review") {
  const utils = await renderApp(path, { signedIn: true, ...opts });
  await screen.findByRole("application", { name: /^שרטוט ת\. חשמל \/ קומת קרקע/ }, LAZY);
  await waitFor(() => expect(markers().length).toBeGreaterThan(20), LAZY);
  return utils;
}
async function openBuilt(opts: RenderAppOptions = {}, path?: string) {
  const utils = await open({ boqPrebuilt: true, ...opts }, path);
  await waitFor(() => expect(document.querySelectorAll("tr[data-line]").length).toBeGreaterThan(5), LAZY);
  return utils;
}

describe("BOQ panel (Sprint 3)", { timeout: 40_000 }, () => {
  it("empty state → 'בנה כתב כמויות' → progress → chapters with % מאומת, codes as LTR text, statuses", async () => {
    const user = userEvent.setup({ delay: null });
    await open();
    const panel = screen.getByRole("region", { name: "כתב כמויות" });
    expect(within(panel).getByRole("tab", { name: "כתב כמויות" })).toHaveAttribute("aria-selected", "true");
    expect(within(panel).getByText("עוד אין כתב כמויות לפרויקט.")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "בנה כתב כמויות" }));
    expect(await within(panel).findByText("בונה כתב כמויות…")).toBeInTheDocument();
    await waitFor(() => expect(panel.querySelectorAll("tr[data-line]").length).toBeGreaterThan(5), LAZY);
    await waitFor(() => expect(toasts().some((t) => /כתב הכמויות מוכן: \d+ שורות/.test(t))).toBe(true));

    const ch = within(panel).getByRole("columnheader", { name: /פרק 04 – עבודות חשמל/ });
    expect(ch).toHaveTextContent(/\d+% מאומת/);
    expect(within(ch).getByRole("img")).toHaveAccessibleName(/מאומת · ▲ \d+ סביר/);
    // chapter notes are collapsible
    const notes = within(ch).getByRole("button", { name: /הערות פרק \(4\)/ });
    expect(notes).toHaveAttribute("aria-expanded", "false");
    await user.click(notes);
    expect(within(panel).getByText(/מפרט הסטנדרטי הבין משרדי/)).toBeInTheDocument();

    const r = row("4.01");
    expect(r.querySelector('bdi[dir="ltr"]')).toHaveTextContent("4.01");
    expect(within(r).getByText("שקע כפול")).toBeInTheDocument();
    expect(within(r).getByText("טיוטה")).toBeInTheDocument();
    expect(within(panel).getByRole("columnheader", { name: /פרק 08/ })).toBeInTheDocument(); // 9.01 install line
    expect(row("9.01")).toHaveTextContent("התקנת גופי התאורה בבית");
    // counts stay available as the secondary tab
    await user.click(within(panel).getByRole("tab", { name: "ספירה לפי סוג" }));
    expect(screen.getByRole("tabpanel", { name: "ספירה לפי סוג" })).toBeInTheDocument();
  });

  it("every number has a receipt: '16 = 14 שזוהו + 2 ידני', by floor, sheets, override reason", async () => {
    await openBuilt();
    const r = row("4.01");
    const qty = within(r).getByRole("button", { name: /קבלה לשורה 4\.01/ });
    expect(r.querySelector("s")).not.toBeNull(); // original struck through
    expect(within(r).getByText(/ידני/)).toBeInTheDocument();
    act(() => qty.focus());
    const receipt = (await screen.findAllByText(/^\d+ = \d+ שזוהו \+ 2 ידני$/))[0]!;
    const card = receipt.closest("[data-receipt]")!;
    const [total, detected] = receipt.textContent!.match(/\d+/g)!.map(Number);
    expect(total! - detected!).toBe(2);
    expect(card).toHaveTextContent(/\d+ פריטים על השרטוט · גיליון אחד/);
    expect(card).toHaveTextContent("קרקע");
    expect(card).toHaveTextContent("עקיפה ידנית: 2 שקעים נוספים לפי שיחה עם הלקוח");
  });

  it("selecting a composite lighting line jumps to the lighting sheet, highlights its items and draws its switch↔point arcs", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt();
    const code = COMPOSITE.find((c) => row(c))!;
    await user.click(within(row(code)).getByRole("button", { name: new RegExp(`^בחר שורה ${code.replace(".", "\\.")}`) }));
    await screen.findByRole("application", { name: /^שרטוט ת\. תאורה \/ קומת קרקע/ }, LAZY);
    await waitFor(() => expect(toasts()).toContain("עברת לגיליון ת. תאורה / קומת קרקע"));
    await waitFor(() => expect(seen.props!.focusIds!.length).toBeGreaterThan(1), LAZY);
    const focus = new Set(seen.props!.focusIds);
    expect(markers().filter((m) => focus.has(m.id)).length).toBe(focus.size);
    await waitFor(() => expect(paths().length).toBeGreaterThan(0), LAZY);
    expect(paths().every((p) => p.dash === "dashed" && p.passive && p.widthPx === 2)).toBe(true);
    expect(hulls().length).toBeGreaterThan(0);
    expect(hulls()[0]!.label).toMatch(/^ק-\d+$/);
    expect(hulls()[0]!.labelLtr).toBe(code);
    expect(row(code)).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("contentinfo")).toHaveTextContent(new RegExp(`${code.replace(".", "\\.")} · (קבוצה אחת|\\d+ קבוצות) · \\d+ פריטים`));
    // composite receipt: qty = switch groups, listed as ק-n per sheet
    act(() => within(row(code)).getByRole("button", { name: /קבלה לשורה/ }).focus());
    const rc = (await screen.findAllByText(/^\d+ = \d+ קבוצות מפסק↔גוף/))[0]!.closest("[data-receipt]")!;
    await waitFor(() => expect(rc.querySelector("[data-receipt-groups]")).toHaveTextContent(/ת\. תאורה \/ קומת קרקע: ק-\d+/), LAZY);
    // sheet switcher shows the line's units (groups) per sheet
    await user.click(screen.getByRole("button", { name: "בחירת גיליון" }));
    expect(await screen.findByRole("menuitemradio", { name: /ת\. תאורה \/ קומת קרקע.*(פריטים|קבוצות) של השורה/ })).toBeInTheDocument();
  });

  it("clicking a marker selects its line (drawing → row)", async () => {
    const { api } = await openBuilt();
    const lines = await api.listBoqLines("p-noah");
    const l = lines.items.find((x) => x.code === "4.01")!;
    const ev = await api.getBoqLineEvidence("p-noah", l.id);
    const det = ev.items.find((e) => e.sheetId === "noah-eb8be8a3-p0")!.detectionId;
    await waitFor(() => {
      act(() => seen.props!.onSelect!([det], { additive: false }));
      expect(row("4.01")).toHaveAttribute("data-selected", "true");
    }, LAZY);
    expect(seen.props!.selectedIds).toEqual([det]);
    await waitFor(() => expect(seen.props!.focusIds).toContain(det), LAZY);
  });

  it("per-floor toggle shows floor columns; shared filters + status filter apply to lines", async () => {
    const user = userEvent.setup({ delay: null });
    await open({ boqPrebuilt: true }, "/projects/p-noah/review?lvl=yellow");
    await waitFor(() => expect(document.querySelectorAll("tr[data-line]").length).toBeGreaterThan(0), LAZY);
    const panel = screen.getByRole("region", { name: "כתב כמויות" });
    const levels = [...panel.querySelectorAll("tr[data-line] [data-level]")].map((e) => e.getAttribute("data-level"));
    expect(levels.length).toBeGreaterThan(0);
    expect(new Set(levels)).toEqual(new Set(["mid"]));
    await user.click(within(panel).getByRole("radio", { name: "לפי קומה" }));
    expect(within(panel).getByRole("columnheader", { name: "קרקע" })).toBeInTheDocument();
    expect(within(panel).getByRole("columnheader", { name: "סה״כ" })).toBeInTheDocument();
    await user.selectOptions(within(panel).getByRole("combobox", { name: /סטטוס/ }), "approved");
    expect(within(panel).getByText("אין שורות שמתאימות למסננים.")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "נקה מסננים" }));
    await waitFor(() => expect(panel.querySelectorAll("tr[data-line]").length).toBeGreaterThan(levels.length));
  });

  it("keyboard: A moves draft → נבדק → אושר (admin), E overrides qty with a required reason, N jumps to the next line to review", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt();
    const code = "4.00";
    await user.click(within(row(code)).getByRole("button", { name: /^בחר שורה 4\.00/ }));
    await user.keyboard("a");
    await waitFor(() => expect(within(row(code)).getByText("נבדק")).toBeInTheDocument());
    await waitFor(() => expect(toasts().some((t) => /^השורה 4\.00 סומנה 'נבדק' · dana@studio\.co\.il, /.test(t))).toBe(true));
    await user.keyboard("a");
    await waitFor(() => expect(within(row(code)).getByText("אושר")).toBeInTheDocument());

    await user.keyboard("e");
    const dlg = await screen.findByRole("dialog", { name: /עריכת כמות/ });
    const qty = within(dlg).getByLabelText("כמות חדשה");
    await user.clear(qty);
    await user.type(qty, "9");
    await user.click(within(dlg).getByRole("button", { name: "שמור כמות" }));
    expect(within(dlg).getByText("חובה לכתוב סיבה.")).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText(/למה משנים את הכמות/), "שקע נוסף במחסן");
    await user.click(within(dlg).getByRole("button", { name: "שמור כמות" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(row(code)).getByRole("button", { name: /^9 — קבלה/ })).toBeInTheDocument();
    expect(toasts()).toContain("הכמות של 4.00 עודכנה ל-9.");

    await user.keyboard("n");
    const sel = document.querySelector<HTMLTableRowElement>("tr[data-line][data-selected]")!;
    expect(sel.getAttribute("data-code")).not.toBe(code);
    expect(sel.querySelector("[data-level]")!.getAttribute("data-level")).not.toBe("high");
  });

  it("editors can mark 'נבדק' but not approve", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt({ orgs: [{ id: "org-demo", name: "סטודיו", role: "editor" }] });
    await user.click(within(row("4.00")).getByRole("button", { name: /^בחר שורה 4\.00/ }));
    await user.click(screen.getByRole("button", { name: "A סמן כ'נבדק'" }));
    await waitFor(() => expect(within(row("4.00")).getByText("נבדק")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^A / })).toBeDisabled();
    await user.keyboard("a");
    expect(toasts()).toContain("אין לך הרשאה לשנות את הסטטוס הזה.");
  });

  it("stale banner after a mapping changes, rebuild keeps the override", async () => {
    const user = userEvent.setup({ delay: null });
    const { api } = await openBuilt();
    const entries = await api.listLegendEntries("p-noah");
    await act(async () => {
      await api.patchLegendEntry("p-noah", entries.items[0]!.id, { action: "confirm" });
    });
    const banner = await screen.findByText("השרטוטים או המיפויים השתנו — בנו מחדש");
    await user.click(within(banner.closest('[role="status"]')!).getByRole("button", { name: "בנו מחדש" }));
    await waitFor(() => expect(screen.queryByText("השרטוטים או המיפויים השתנו — בנו מחדש")).toBeNull(), LAZY);
    expect(within(row("4.01")).getByText(/ידני/)).toBeInTheDocument();
  });

  it("export: the spec's warning copy for non-green lines, then (mock) a toast instead of a file", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt();
    await user.click(screen.getByRole("button", { name: "ייצוא" }));
    const dlg = await screen.findByRole("dialog", { name: "ייצוא כתב כמויות לאקסל" });
    expect(within(dlg).getByText("יש פריטים שלא נבדקו")).toBeInTheDocument();
    expect(within(dlg).getByText(/בכתב הכמויות יש .*"לבדיקה".* ו-.*"סביר"\. הכמויות בהן עלולות להיות שגויות\./)).toBeInTheDocument();
    expect(within(dlg).getByText(/בקובץ תופיע עמודת "סטטוס ביטחון"/)).toBeInTheDocument();
    expect(within(dlg).getByRole("checkbox", { name: /טיוטה – כולל פריטים שלא אומתו/ })).toBeChecked();
    expect(within(dlg).getByRole("combobox", { name: "תבנית" })).toHaveValue("tpl-default");
    await user.click(within(dlg).getByRole("radio", { name: "מפורק לפי קומה" }));
    expect(within(dlg).getByRole("button", { name: "חזרה לבדיקה (מומלץ)" })).toBeInTheDocument();
    expect(await axe(dlg)).toHaveNoViolations();
    await user.click(within(dlg).getByRole("button", { name: /ייצא בכל זאת/ }));
    await waitFor(() => expect(toasts().some((t) => /^מצב הדגמה: הקובץ לא נוצר.*boq-p-noah-byFloor\.xlsx/.test(t))).toBe(true));
  });

  it("export is blocked when the org blocks red lines; 'עבור לפריטים' filters to ◆", async () => {
    const user = userEvent.setup({ delay: null });
    const { router } = await openBuilt({ blockExportOnRed: true });
    await user.click(screen.getByRole("button", { name: "ייצוא" }));
    const dlg = await screen.findByRole("dialog", { name: "ייצוא כתב כמויות לאקסל" });
    expect(within(dlg).getByText("לא ניתן לייצא עדיין.")).toBeInTheDocument();
    expect(within(dlg).getByText(/מדיניות המשרד מחייבת לטפל בכל הפריטים שמסומנים 'לבדיקה' לפני ייצוא\. נותרו \d+\./)).toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: /ייצא/ })).toBeNull();
    await user.click(within(dlg).getByRole("button", { name: "עבור לפריטים" }));
    await waitFor(() => expect(router.state.location.search).toContain("lvl=red"));
    const levels = [...document.querySelectorAll("tr[data-line] [data-level]")].map((e) => e.getAttribute("data-level"));
    expect(new Set(levels)).toEqual(new Set(["low"]));
  });

  it("is accessible (axe) with lines and a selection", async () => {
    await openBuilt();
    fireEvent.click(within(row("4.01")).getByRole("button", { name: /^בחר שורה 4\.01/ }));
    expect(await axe(screen.getByRole("region", { name: "כתב כמויות" }))).toHaveNoViolations();
  });
});
