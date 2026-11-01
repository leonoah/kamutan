import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DrawingViewerProps, PolygonFeature } from "@kamutan/viewer";
import { axe } from "@/test/axe";
import { renderApp, type RenderAppOptions } from "@/test/utils";
import { MAX_VISIBLE_TOASTS, Toaster, toast, useToastStore } from "@/components/ui/toast";

const seen: { props: DrawingViewerProps | null } = { props: null };
const LAZY = { timeout: 25_000 };
beforeAll(async () => {
  await import("@/features/review/ReviewPage");
  await import("@/features/viewer/SheetViewer");
}, 60_000);
vi.mock("@kamutan/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kamutan/viewer")>();
  return {
    ...actual,
    DrawingViewer: (p: DrawingViewerProps) => {
      if (p) seen.props = p;
      return <div role="application" aria-label={p.ariaLabel} dir="ltr" />;
    },
  };
});

const toasts = () => useToastStore.getState().items.map((t) => t.title);
const row = (code: string) => document.querySelector<HTMLTableRowElement>(`tr[data-code="${code}"]`)!;
async function openBuilt(opts: RenderAppOptions = {}) {
  const utils = await renderApp("/projects/p-noah/review", { signedIn: true, boqPrebuilt: true, ...opts });
  await screen.findByRole("application", { name: /^שרטוט ת\. חשמל \/ קומת קרקע/ }, LAZY);
  await waitFor(() => expect(row("7.01")).toBeTruthy(), LAZY);
  return utils;
}
beforeEach(() => useToastStore.setState({ items: [] }));

describe("Sprint 6: suggested lines, origin badges, coverage, quick actions", { timeout: 60_000 }, () => {
  it("a suggested line shows 'להשלמה ידנית', its unit, reason, a missing qty and a quick action; chapters show coverage", async () => {
    const { container } = await openBuilt();
    const r = row("7.01");
    expect(r).toHaveAttribute("data-needs-input", "true");
    expect(within(r).getByText("להשלמה ידנית")).toBeInTheDocument();
    expect(within(r).getByText("מוצע")).toBeInTheDocument();
    expect(within(r).getByText('מ"ר')).toBeInTheDocument();
    expect(within(r).getByText(/תקרת הגבס/)).toBeInTheDocument();
    expect(within(r).getByText("חסרה כמות")).toBeInTheDocument();
    expect(within(r).getByRole("button", { name: "מדידת שטח לסעיף 7.01" })).toBeInTheDocument();
    // origins on other lines
    expect(row("4.01").querySelector("[data-origin]")).toHaveTextContent("סמלים");
    expect(within(row("4.18")).getByText("כיתוב")).toBeInTheDocument();
    expect(within(row("5.04")).getByText("מדידה")).toBeInTheDocument();
    // coverage per chapter
    const ch06 = screen.getByRole("columnheader", { name: /פרק 06/ });
    expect(ch06).toHaveTextContent(/\d+ מתוך \d+ סעיפים חושבו מהשרטוט · \d+ להשלמה/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("filter 'להשלמה ידנית' shows only waiting lines", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt();
    const chip = screen.getByRole("button", { name: /^להשלמה ידנית \(\d+\)$/ });
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    const rows = [...document.querySelectorAll("tr[data-line]")];
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.hasAttribute("data-needs-input"))).toBe(true);
  });

  it("measure quick action: opens the area tool bound to the line; the result saves through quick-measure", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt();
    await user.click(within(row("7.01")).getByRole("button", { name: "מדידת שטח לסעיף 7.01" }));
    await waitFor(() => expect(seen.props?.tool).toBe("area"));
    expect(document.querySelector("[data-quick-banner]")).toHaveTextContent(/מדידת שטח לסעיף\s*7\.01/);
    act(() => {
      seen.props!.onArea!({ polygonMm: [[10, 10], [60, 10], [60, 40]], paperMm2: 750, paperPerimeterMm: 140, areaM2: 4.2, perimeterM: 7 });
    });
    // optimistic: the line is no longer waiting at once
    await waitFor(() => expect(row("7.01")).not.toHaveAttribute("data-needs-input"));
    expect(within(row("7.01")).getByRole("button", { name: /^4\.2\b.*קבלה לשורה 7\.01/ })).toBeInTheDocument();
    await waitFor(() => expect(toasts()).toContain('נשמרה כמות 4.2 מ"ר לסעיף 7.01.'));
    await waitFor(() => expect(row("7.01")).toHaveAttribute("data-origin", "manual"));
    expect(seen.props?.tool).toBe("select");
  });

  it("confirm quick action: a dialog prefilled with the estimate; saving completes the line", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt();
    await user.click(within(row("8.03")).getByRole("button", { name: "אישור כמות לסעיף 8.03" }));
    const dlg = await screen.findByRole("dialog", { name: /אישור כמות/ });
    const input = within(dlg).getByLabelText("כמות (קומפלט)");
    expect(input).toHaveValue("1");
    await user.clear(input);
    await user.type(input, "2");
    await user.click(within(dlg).getByRole("button", { name: "אשר כמות" }));
    await waitFor(() => expect(row("8.03")).not.toHaveAttribute("data-needs-input"));
    await waitFor(() => expect(within(row("8.03")).getByRole("button", { name: /^2\b.*קבלה לשורה 8\.03/ })).toBeInTheDocument());
  });

  it("text / stair evidence is highlighted on the drawing when the line is selected", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt();
    await user.click(within(row("4.18")).getByRole("button", { name: /^בחר שורה 4\.18/ }));
    await waitFor(() => expect((seen.props?.overlays ?? []).some((f) => f.kind === "polygon" && f.id.startsWith("ev-") && (f as PolygonFeature).label === "נק' אינטרקום")).toBe(true));
    await user.click(within(row("5.04")).getByRole("button", { name: /^בחר שורה 5\.04/ }));
    await waitFor(() => expect((seen.props?.overlays ?? []).filter((f) => f.id.startsWith("ev-") && f.id.includes("-t")).length).toBe(11));
  });
});

describe("Owner feedback: bulk approve, no toast per status, 'already approved'", { timeout: 60_000 }, () => {
  it("A changes the status inline (no toast); A on an approved line says it is already approved (admin)", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt();
    await user.click(within(row("4.00")).getByRole("button", { name: /^בחר שורה 4\.00/ }));
    await user.keyboard("a");
    await waitFor(() => expect(within(row("4.00")).getByText("נבדק")).toBeInTheDocument());
    await user.keyboard("a");
    await waitFor(() => expect(within(row("4.00")).getByText("אושר")).toBeInTheDocument());
    expect(screen.getByTestId("live-msg")).toHaveTextContent("השורה 4.00 סומנה 'אושר'.");
    expect(toasts()).toEqual([]);
    await user.keyboard("a");
    await user.keyboard("a");
    await waitFor(() => expect(toasts()).toEqual(["השורה 4.00 כבר מאושרת."])); // deduplicated, not a permission error
    expect(useToastStore.getState().items[0]!.repeat).toBe(2);
  });

  it("checkbox + shift range + chapter; 'אשר (N)' → confirm with the count → ONE summary toast → undo", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt();
    await user.click(within(row("4.00")).getByRole("checkbox", { name: "בחר את שורה 4.00" }));
    await user.keyboard("{Shift>}");
    await user.click(within(row("4.03")).getByRole("checkbox", { name: "בחר את שורה 4.03" }));
    await user.keyboard("{/Shift}");
    const checked = [...document.querySelectorAll("tr[data-checked]")].map((r) => r.getAttribute("data-code"));
    expect(checked.length).toBeGreaterThanOrEqual(4);
    expect(checked).toEqual(expect.arrayContaining(["4.00", "4.01", "4.02", "4.03"]));
    const bar = screen.getByRole("region", { name: "פעולות על השורות שנבחרו" });
    const approve = within(bar).getByRole("button", { name: /^אשר \(\d+\)/ });
    await user.click(approve);
    // the dialog states the count and what is left out (the red lines of the range)
    const dlg = await screen.findByRole("dialog", { name: /^לאשר (\d+ שורות|שורה אחת)\?$/ });
    expect(dlg).toHaveTextContent(/לא ישתנו: \d+ אדומות/);
    expect(await axe(dlg)).toHaveNoViolations();
    await user.click(within(dlg).getByRole("button", { name: /^אשר \d+$/ }));
    await waitFor(() => expect(toasts().filter((t) => /^(אושרו \d+ שורות|אושרה שורה אחת) · \d+ דולגו \(\d+ אדומות\)$/.test(t))).toHaveLength(1));
    expect(toasts()).toHaveLength(1);
    const approved = checked.filter((c) => row(c!).querySelector('[data-status="approved"]'));
    expect(approved.length).toBeGreaterThanOrEqual(1);
    // red lines of the range were not touched
    for (const c of checked) if (row(c!).querySelector("[data-level]")?.getAttribute("data-level") === "low") expect(row(c!).querySelector('[data-status="approved"]')).toBeNull();
    expect(screen.queryByRole("region", { name: "פעולות על השורות שנבחרו" })).toBeNull();
    // undo through the same endpoint
    act(() => useToastStore.getState().items[0]!.action!.onClick());
    await waitFor(() => expect(approved.every((c) => row(c!).querySelector('[data-status="draft"]'))).toBe(true));
    await waitFor(() => expect(toasts().some((t) => /^השינוי בוטל/.test(t))).toBe(true));
  });

  it("red lines are left out unless opted in (warning + count in the dialog); Shift+A opens the confirmation", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt();
    // chapter checkbox: chapter 06's red lines all wait for input (never marked) → no red opt-in offered
    await user.click(screen.getByRole("checkbox", { name: /^בחר את כל השורות בפרק 06/ }));
    let bar = screen.getByRole("region", { name: "פעולות על השורות שנבחרו" });
    expect(within(bar).queryByLabelText(/^כולל .*אדומ/)).toBeNull();
    await user.click(within(bar).getByRole("button", { name: "נקה בחירה" }));
    // all lines: red computed lines are offered behind an explicit opt-in
    await user.click(screen.getByRole("checkbox", { name: /^בחר הכל/ }));
    bar = screen.getByRole("region", { name: "פעולות על השורות שנבחרו" });
    expect(within(bar).getByLabelText(/^כולל \d+ שורות? אדומ/)).not.toBeChecked();
    await user.keyboard("{Shift>}a{/Shift}");
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent(/לא ישתנו: .*להשלמה ידנית/);
    await user.keyboard("{Escape}");
    await user.click(within(bar).getByLabelText(/^כולל \d+ שורות? אדומ/));
    expect(within(bar).getByRole("note")).toHaveTextContent(/שורות אדומות לא נבדקו/);
  });

  it("editors get both 'סמן כנבדק' and 'אשר' (SEC-07)", async () => {
    const user = userEvent.setup({ delay: null });
    await openBuilt({ orgs: [{ id: "org-demo", name: "סטודיו", role: "editor" }] });
    await user.click(screen.getByRole("checkbox", { name: /^בחר הכל/ }));
    const bar = screen.getByRole("region", { name: "פעולות על השורות שנבחרו" });
    expect(within(bar).getByRole("button", { name: /^סמן כנבדק \(\d+\)/ })).toBeEnabled();
    expect(within(bar).getByRole("button", { name: /^אשר \(\d+\)/ })).toBeInTheDocument();
  });

  it("viewers get no checkboxes", async () => {
    await openBuilt({ orgs: [{ id: "org-demo", name: "סטודיו", role: "viewer" }] });
    expect(document.querySelector('tr[data-line] input[type="checkbox"]')).toBeNull();
  });
});

describe("Toaster: at most 3, newest on top, older collapse into '+N הודעות', duplicates merge", () => {
  it("caps and collapses", async () => {
    const user = userEvent.setup({ delay: null });
    render(<Toaster />);
    act(() => {
      for (let i = 1; i <= 6; i++) toast({ title: `הודעה ${i}` });
    });
    const shown = screen.getAllByText(/^הודעה \d$/).map((e) => e.textContent);
    expect(shown).toEqual(["הודעה 6", "הודעה 5", "הודעה 4"]);
    expect(shown).toHaveLength(MAX_VISIBLE_TOASTS);
    const more = screen.getByRole("button", { name: "+3 הודעות" });
    await user.click(more);
    expect(screen.getAllByText(/^הודעה \d$/)).toHaveLength(6);
    act(() => toast({ title: "הודעה 6" }));
    expect(useToastStore.getState().items.filter((i) => i.title === "הודעה 6")).toHaveLength(1);
  });
  it("errors auto-dismiss faster than summaries with an undo", async () => {
    const { toastDuration } = await import("@/components/ui/toast");
    expect(toastDuration({ tone: "error" })).toBeLessThanOrEqual(6000);
    expect(toastDuration({ tone: "error" })).toBeGreaterThanOrEqual(4000);
    expect(toastDuration({ tone: "success", action: { label: "x", onClick: () => undefined } })).toBeGreaterThan(toastDuration({ tone: "neutral" }));
  });
});
