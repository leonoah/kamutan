import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DrawingViewerProps, MarkerFeature, PolygonFeature } from "@kamutan/viewer";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";
import { useToastStore } from "@/components/ui/toast";

const seen: { props: DrawingViewerProps | null } = { props: null };
const LAZY = { timeout: 10_000 };
vi.mock("@kamutan/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kamutan/viewer")>();
  return {
    ...actual,
    DrawingViewer: (p: DrawingViewerProps) => {
      // React dev builds call function components without props to describe warning stacks: keep the last real props.
      if (p) seen.props = p;
      return (
        <div role="application" aria-label={p.ariaLabel} dir="ltr">
          {p.popover ? (
            <div role="dialog" aria-label={p.popover.label} dir="rtl">
              {p.popover.content}
            </div>
          ) : null}
        </div>
      );
    },
  };
});

const markers = () => (seen.props?.overlays ?? []).filter((f): f is MarkerFeature => f.kind === "marker");
const polygons = () => (seen.props?.overlays ?? []).filter((f): f is PolygonFeature => f.kind === "polygon");

async function open(path = "/projects/p-noah/review?panel=counts") {
  const utils = await renderApp(path, { signedIn: true });
  await screen.findByRole("application", { name: /^שרטוט ת\. חשמל \/ קומת קרקע/ }, LAZY);
  await waitFor(() => expect(markers().length).toBeGreaterThan(100), LAZY);
  return utils;
}

describe("Review workspace with the Sprint-2 overlay", { timeout: 30_000 }, () => {
  it("renders the three panes in RTL order with an LTR drawing", async () => {
    const { container } = await open();
    const counts = screen.getByRole("region", { name: "כתב כמויות" });
    expect(screen.getByRole("tabpanel", { name: "ספירה לפי סוג" })).toBeInTheDocument();
    const drawing = screen.getByRole("region", { name: "שרטוט" });
    const queue = screen.getByRole("region", { name: "תור בדיקה" });
    const order = [counts, drawing, queue].map((el) => [...container.querySelectorAll("section")].indexOf(el as HTMLElement));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(drawing.querySelector('[dir="ltr"]')).not.toBeNull();
    expect(await screen.findByRole("link", { name: "בית משפחת נח" })).toBeInTheDocument();
  });

  it("draws detections as markers with level colour + shape, rooms with name + area, and the legend box", async () => {
    await open();
    const all = markers();
    expect(all).toHaveLength(150); // 140 + 7 + 3 unknown (fixture)
    const shapes = new Set(all.map((m) => m.shape));
    expect(shapes).toEqual(new Set(["circle", "triangle", "diamond", "diamond-open"]));
    const unknown = all.filter((m) => m.shape === "diamond-open");
    expect(unknown).toHaveLength(10);
    expect(unknown[0]!.color).toEqual([109, 40, 217, 255]);
    // lifecycle: existing / demolish are dashed and dimmed by default (only "חדש" is on)
    const dashed = all.filter((m) => m.dashed);
    expect(dashed.length).toBeGreaterThan(0);
    expect(dashed.every((m) => m.dimmed)).toBe(true);
    expect(all.filter((m) => !m.dashed).every((m) => !m.dimmed)).toBe(true);
    const room = polygons().find((p) => p.label === "סלון")!;
    expect(room.labelLtr).toBe("26.0");
    expect(room.labelSuffix).toBe("מ״ר");
    expect(polygons().find((p) => p.id === "lg0")?.dashed).toBe(true);
  });

  it("the קיים / חדש / להריסה toggles un-dim the lifecycle layers", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("checkbox", { name: /קיים/ }));
    await waitFor(() => expect(markers().filter((m) => m.dashed && !m.strike).every((m) => !m.dimmed)).toBe(true));
    await user.click(screen.getByRole("checkbox", { name: /^\s*חדש/ }));
    await waitFor(() => expect(markers().filter((m) => !m.dashed).every((m) => m.dimmed)).toBe(true));
  });

  it("'ספירה לפי סוג' groups by class with counts by level; selecting a row focuses its markers (and back)", async () => {
    const user = userEvent.setup();
    await open();
    const panel = screen.getByRole("tabpanel", { name: "ספירה לפי סוג" });
    const table = within(panel).getByRole("table", { name: "ספירת פריטים לפי סוג ורמת ביטחון" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.length).toBe(8); // 7 classes + unknown
    const first = rows[0]!;
    expect(first).toHaveAttribute("data-class", "socket_double");
    const btn = within(first).getByRole("button", { name: /שקע כפול/ });
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "true");
    const total = Number(within(first).getAllByRole("cell").at(-1)!.textContent);
    await waitFor(() => expect(seen.props!.focusIds).toHaveLength(total));
    expect(screen.getByRole("contentinfo")).toHaveTextContent(`שקע כפול · ${total} פריטים`);

    // drawing → row: clicking a marker of another class selects that class row and opens the details popover
    const other = markers().find((m) => m.shape !== "diamond-open" && !seen.props!.focusIds!.includes(m.id))!;
    act(() => seen.props!.onSelect!([other.id], { additive: false }));
    const dialog = await screen.findByRole("dialog", { name: "פרטי פריט" });
    expect(dialog).toHaveAttribute("dir", "rtl");
    expect(within(dialog).getByText(/^ביטחון 0\.\d\d$/)).toBeInTheDocument();
    expect(within(dialog).getByText("שורת מקרא")).toBeInTheDocument();
    expect(within(dialog).getByText("חדר")).toBeInTheDocument();
    const selectedRow = table.querySelector("tr[data-selected]")!;
    expect(selectedRow.getAttribute("data-class")).not.toBe("socket_double");
    expect(seen.props!.selectedIds).toEqual([other.id]);
  });

  it("filters (ביטחון chips + URL) apply to the overlay and the counts", async () => {
    const user = userEvent.setup();
    const { router } = await open();
    const bar = screen.getByRole("toolbar", { name: "סינון" });
    const greenChip = within(bar).getByRole("button", { name: /מאומת/ });
    await user.click(greenChip);
    expect(greenChip).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(markers().some((m) => m.shape === "circle")).toBe(false));
    expect(router.state.location.search).toContain("lvl=yellow%2Cred%2Cunknown");
    await user.click(within(bar).getByRole("button", { name: "נקה" }));
    await waitFor(() => expect(markers()).toHaveLength(150));
  });

  it("room filter keeps only that room's items and dims the other rooms", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("button", { name: "חדר: הכל" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "סלון" }));
    await waitFor(() => expect(polygons().filter((p) => p.label && p.id.startsWith("r_") && !p.dimmed).map((p) => p.label)).toEqual(["סלון"]));
    expect(markers().length).toBeGreaterThan(0);
    expect(markers().length).toBeLessThan(150);
  });

  it("'מה זה?': one card per unknown cluster; a location jumps the drawing; answering re-labels all instances (optimistic) + toast", async () => {
    const user = userEvent.setup();
    const { api } = await open();
    const spy = vi.spyOn(api, "resolveUnknownCluster");
    const queue = screen.getByRole("region", { name: "תור בדיקה" });
    const card = within(queue).getByRole("article", { name: "סמל לא מוכר × 7 מופעים" });
    expect(within(card).getByRole("img", { name: "סמל לא מוכר" })).toBeInTheDocument();
    await user.click(within(card).getAllByRole("button", { name: /^מופע 1/ })[0]!);
    await waitFor(() => expect(seen.props!.selectedIds).toHaveLength(1));
    expect(await screen.findByRole("dialog", { name: "פרטי פריט" })).toHaveTextContent("סמל לא מוכר");

    await user.selectOptions(within(card).getByRole("combobox", { name: "מה הסמל הזה?" }), "socket_power");
    await user.click(within(card).getByRole("button", { name: "החל על 7 מופעים" }));
    await waitFor(() => expect(within(queue).queryByRole("article", { name: "סמל לא מוכר × 7 מופעים" })).toBeNull());
    expect(spy).toHaveBeenCalledWith("p-noah", "u_1", {
      sheetId: "noah-eb8be8a3-p0",
      versionId: "v1",
      createLegendEntry: true,
      class: "socket_power",
    });
    expect(markers().filter((m) => m.shape === "diamond-open")).toHaveLength(3);
    await waitFor(() => expect(useToastStore.getState().items.map((i) => i.title)).toContain("7 מופעים שויכו ל'שקע כח'."));

    // "לא רלוונטי" drops the instances
    const card2 = within(queue).getByRole("article", { name: "סמל לא מוכר × 3 מופעים" });
    await user.selectOptions(within(card2).getByRole("combobox", { name: "מה הסמל הזה?" }), "__ignore");
    await user.click(within(card2).getByRole("button", { name: "החל על 3 מופעים" }));
    await waitFor(() => expect(markers()).toHaveLength(147));
    expect(spy).toHaveBeenLastCalledWith("p-noah", "u_2", expect.objectContaining({ ignore: true, createLegendEntry: false }));
    expect(queue.querySelector('[data-queue-item^="uc:noah-eb8be8a3-p0:"]')).toBeNull();
  });

  it("rolls back the optimistic answer when the API fails", async () => {
    const user = userEvent.setup();
    const { api } = await open();
    vi.spyOn(api, "resolveUnknownCluster").mockRejectedValueOnce(new Error("boom"));
    const queue = screen.getByRole("region", { name: "תור בדיקה" });
    const card = within(queue).getByRole("article", { name: "סמל לא מוכר × 3 מופעים" });
    await user.selectOptions(within(card).getByRole("combobox", { name: "מה הסמל הזה?" }), "data_point");
    await user.click(within(card).getByRole("button", { name: "החל על 3 מופעים" }));
    await waitFor(() => expect(useToastStore.getState().items.map((i) => i.title)).toContain("לא הצלחנו לשמור את התשובה. נסו שוב."));
    expect(markers().filter((m) => m.shape === "diamond-open")).toHaveLength(10);
    expect(within(queue).getByRole("article", { name: "סמל לא מוכר × 3 מופעים" })).toBeInTheDocument();
  });

  it("header shows the real verified share; the queue lists all kinds of open items ranked by risk, with a time estimate", async () => {
    const { api } = await open();
    expect(screen.getByRole("progressbar", { name: /% מאומת$/ })).toBeInTheDocument();
    const queue = screen.getByRole("region", { name: "תור בדיקה" });
    await waitFor(() => expect(within(queue).getAllByRole("button", { name: /^התמקד ב/ }).length).toBeGreaterThan(10), LAZY);
    const ranked = (await api.getReviewQueue("p-noah")).items;
    const risks = ranked.map((i) => i.risk);
    expect(risks).toEqual([...risks].sort((a, b) => b - a));
    const shown = [...queue.querySelectorAll("[data-queue-item]")].map((e) => e.getAttribute("data-queue-item"));
    expect(shown).toEqual(ranked.map((i) => i.id));
    expect(new Set(ranked.map((i) => i.kind))).toEqual(new Set(["cluster", "detection", "unknown_cluster", "room"]));
    expect(within(queue).getByTestId("queue-remaining")).toHaveTextContent(/^נותרו \d+ · כ-\d+ דק'$/);
    // entry: the highest-risk item of the opened sheet is active
    expect(queue.querySelector("article[data-active]")).not.toBeNull();
  });

  it("has no axe violations with the overlay, counts and 'מה זה?' cards", async () => {
    const { container } = await open();
    act(() => seen.props!.onSelect!([markers()[0]!.id], { additive: false }));
    await screen.findByRole("dialog", { name: "פרטי פריט" });
    expect(await axe(container)).toHaveNoViolations();
  });
});
