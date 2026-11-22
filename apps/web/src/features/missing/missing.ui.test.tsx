import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DrawingViewerProps } from "@kamutan/viewer";
import { axe } from "@/test/axe";
import { renderApp, type RenderAppOptions } from "@/test/utils";
import { useToastStore } from "@/components/ui/toast";

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
const chip = (name: RegExp) => within(screen.getByRole("group", { name: "סינון הסעיפים" })).getByRole("button", { name });
const item = (code: string) => document.querySelector<HTMLElement>(`[data-missing-item="${code}"]`);
async function openMissing(opts: RenderAppOptions = {}) {
  const utils = await renderApp("/projects/p-noah/review?panel=missing", { signedIn: true, boqPrebuilt: true, ...opts });
  await screen.findByRole("application", { name: /^שרטוט ת\. חשמל \/ קומת קרקע/ }, LAZY);
  await waitFor(() => expect(document.querySelector("[data-missing-panel]")).toBeTruthy(), LAZY);
  return utils;
}
beforeEach(() => useToastStore.setState({ items: [] }));

describe("Sprint 15: סעיפים שלא זוהו", { timeout: 60_000 }, () => {
  it("is the third tab of the panel: chapters with titles, items in code order, filters with counts and a counter", async () => {
    const { container } = await openMissing();
    expect(screen.getByRole("tab", { name: /סעיפים שלא זוהו/, selected: true })).toBeInTheDocument();
    const chapters = [...document.querySelectorAll<HTMLElement>("[data-missing-chapter]")].map((c) => c.dataset.missingChapter);
    expect(chapters.length).toBeGreaterThan(3);
    expect(chapters).toEqual([...chapters].sort());
    expect(document.querySelector("[data-missing-chapter] h3")).toHaveTextContent(/^פרק 01/);
    const codes = [...document.querySelectorAll<HTMLElement>('[data-missing-chapter="04"] [data-missing-item]')].map((r) => r.dataset.missingItem!);
    expect(codes.length).toBeGreaterThan(1);
    expect(codes).toEqual([...codes].sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1])));
    const all = Number(document.querySelector('[data-missing-count="all"]')!.textContent);
    expect(all).toBeGreaterThan(10);
    expect(document.querySelector("[data-missing-counter]")).toHaveTextContent(`${all} סעיפים`);
    expect(chip(/^הכל/)).toHaveAttribute("aria-pressed", "true");
    expect(chip(/^בפרויקט/)).toBeInTheDocument();
    expect(chip(/^לא רלוונטי/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("'לא רלוונטי בפרויקט הזה' moves the item to the 'לא רלוונטי' filter with an undo toast; 'החזר' brings it back", async () => {
    const user = userEvent.setup({ delay: null });
    await openMissing();
    const before = Number(document.querySelector('[data-missing-count="all"]')!.textContent);
    await user.click(within(item("2.01")!).getByRole("button", { name: "לא רלוונטי בפרויקט הזה" }));
    await waitFor(() => expect(toasts()).toContain("הסעיף 2.01 סומן כלא רלוונטי בפרויקט הזה."));
    await waitFor(() => expect(document.querySelector('[data-missing-count="not_relevant"]')).toHaveTextContent("1"));
    expect(document.querySelector('[data-missing-count="in_project"]')).toHaveTextContent(String(before - 1));
    // it stays in "הכל" (as a hidden item) and shows under "לא רלוונטי"
    expect(item("2.01")).toHaveAttribute("data-state", "not_relevant");
    await user.click(chip(/^לא רלוונטי/));
    await waitFor(() => expect([...document.querySelectorAll("[data-missing-item]")].map((e) => e.getAttribute("data-missing-item"))).toEqual(["2.01"]));
    await user.click(within(item("2.01")!).getByRole("button", { name: "החזר" }));
    await waitFor(() => expect(toasts()).toContain("הסעיף 2.01 הוחזר לכתב הכמויות."));
    await waitFor(() => expect(document.querySelector("[data-missing-empty]")).toBeTruthy());
    await user.click(chip(/^בפרויקט/));
    await waitFor(() => expect(item("2.01")).toBeTruthy());
  });

  it("the undo action on the toast restores the item", async () => {
    const user = userEvent.setup({ delay: null });
    const { api } = await openMissing();
    await user.click(within(item("2.03")!).getByRole("button", { name: "לא רלוונטי בפרויקט הזה" }));
    await waitFor(() => expect(useToastStore.getState().items.some((t) => t.action?.label === "בטל")).toBe(true));
    act(() => useToastStore.getState().items.find((t) => t.action?.label === "בטל")!.action!.onClick());
    await waitFor(async () => expect((await api.getMissingItems("p-noah", "not_relevant")).items).toHaveLength(0));
  });

  it("'סמן בשרטוט' starts the count tool bound to the item; the result is saved as a manual correction and offers 'למד' for a symbol item", async () => {
    const user = userEvent.setup({ delay: null });
    const { api } = await openMissing();
    const spy = vi.spyOn(api, "createCorrection");
    await user.click(within(item("4.04")!).getByRole("button", { name: "סמן בשרטוט" }));
    await waitFor(() => expect(seen.props?.tool).toBe("count"));
    expect(document.querySelector("[data-mark-banner]")).toHaveTextContent(/ספירה לסעיף\s*4\.04/);
    act(() => {
      seen.props!.onCount!({ pointsMm: [[40, 50]] });
    });
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith("p-noah", expect.objectContaining({ kind: "count", itemCode: "4.04", quantity: 1, unit: "unit" })),
    );
    expect(seen.props?.tool).toBe("select");
    await waitFor(() => expect(toasts()).toContain("נשמרה כמות ידנית לסעיף 4.04: 1 יחידה."));
    // symbol-based item: the existing "למד מהתיקון" offer follows
    await waitFor(() => expect(document.querySelector("[data-learn-offer]")).toBeTruthy());
    // the item has a quantity now: off the list
    await waitFor(() => expect(item("4.04")).toBeNull());
  });

  it("an area item starts the area tool and does not offer 'למד'; a lump-sum item has no 'סמן בשרטוט'", async () => {
    const user = userEvent.setup({ delay: null });
    await openMissing();
    expect(within(item("1.01")!).queryByRole("button", { name: "סמן בשרטוט" })).toBeNull();
    expect(item("1.01")).toHaveTextContent("סעיף חד-פעמי");
    await user.click(within(item("2.01")!).getByRole("button", { name: "סמן בשרטוט" }));
    await waitFor(() => expect(seen.props?.tool).toBe("area"));
    act(() => {
      seen.props!.onArea!({ polygonMm: [[10, 10], [60, 10], [60, 40]], paperMm2: 750, paperPerimeterMm: 140, areaM2: 4.2, perimeterM: 7 });
    });
    await waitFor(() => expect(toasts()).toContain('נשמרה כמות ידנית לסעיף 2.01: 4.2 מ"ר.'));
    expect(document.querySelector("[data-learn-offer]")).toBeNull();
  });

  it("a viewer sees the list but has no actions", async () => {
    await openMissing({ orgs: [{ id: "org-demo", name: "x", role: "viewer" }] });
    expect(item("2.01")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "לא רלוונטי בפרויקט הזה" })).toBeNull();
    expect(screen.queryByRole("button", { name: "סמן בשרטוט" })).toBeNull();
  });

  it("a reviewer may mark in the drawing but not exclude", async () => {
    await openMissing({ orgs: [{ id: "org-demo", name: "x", role: "reviewer" }] });
    expect(within(item("2.01")!).getByRole("button", { name: "סמן בשרטוט" })).toBeInTheDocument();
    expect(within(item("2.01")!).queryByRole("button", { name: "לא רלוונטי בפרויקט הזה" })).toBeNull();
  });
});
