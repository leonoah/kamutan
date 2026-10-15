import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DrawingViewerProps, MarkerFeature } from "@kamutan/viewer";
import type { DetectionsArtifact } from "@/api/types";
import { axe } from "@/test/axe";
import { renderApp, type RenderAppOptions } from "@/test/utils";
import { useToastStore } from "@/components/ui/toast";
import { useHistoryStore } from "@/features/corrections/queries";

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
      // React dev builds call function components without props to describe warning stacks: keep the last real props.
      if (p) seen.props = p;
      return (
        <div role="application" aria-label={p?.ariaLabel} dir="ltr">
          {p?.popover ? (
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
const toasts = () => useToastStore.getState().items.map((t) => t.title);
const queue = () => screen.getByRole("region", { name: "תור בדיקה" });
const active = () => queue().querySelector<HTMLElement>("article[data-active]");
/** Physical key with a Hebrew layout character (keys work by event.code). */
const press = (code: string, key: string, extra: KeyboardEventInit = {}) => act(() => void fireEvent.keyDown(document.body, { code, key, ...extra }));

async function open(opts: RenderAppOptions = {}, path = "/projects/p-noah/review", sheet = /^שרטוט ת\. חשמל \/ קומת קרקע/, min = 100) {
  useHistoryStore.setState({ byProject: {} });
  const utils = await renderApp(path, { signedIn: true, ...opts });
  await screen.findByRole("application", { name: sheet }, LAZY);
  await waitFor(() => expect(markers().length).toBeGreaterThan(min), LAZY);
  await waitFor(() => expect(active()).not.toBeNull(), LAZY);
  return utils;
}
async function detections(api: Awaited<ReturnType<typeof open>>["api"], sheetId: string) {
  const m = await api.getOverlay("p-noah", sheetId, "v1");
  return (JSON.parse(decodeURIComponent(m.detections!.url.split(",")[1]!)) as DetectionsArtifact).detections;
}
const activate = async (kind: string, n = 0) => {
  const card = queue().querySelectorAll<HTMLElement>(`[data-queue-item^="${kind === "cluster" ? "cl" : "det"}:noah-eb8be8a3-p0"] article`)[n]!;
  await act(async () => within(card).getAllByRole("button")[0]!.click());
  await waitFor(() => expect(card).toHaveAttribute("data-active", "true"));
  return card.closest("[data-queue-item]")!.getAttribute("data-queue-item")!;
};

describe("Sprint 4: review queue, correction tools, learn from correction, rooms", { timeout: 60_000 }, () => {
  it("A on a cluster card accepts all its items in ONE batch (physical key on a Hebrew layout), the next item loads; Z / Shift+Z undo and redo it", async () => {
    const { api } = await open();
    const batch = vi.spyOn(api, "createCorrectionsBatch");
    const revert = vi.spyOn(api, "revertCorrectionsBatch");
    const id = await activate("cluster");
    const card = queue().querySelector(`[data-queue-item="${CSS.escape(id)}"] article`)!;
    const members = within(card as HTMLElement).getAllByRole("button", { name: /^מופע \d+ של/ }).length;
    expect(card).toHaveTextContent(/· \d+ מופעים/);
    press("KeyA", "ש");
    await waitFor(() => expect(batch).toHaveBeenCalledTimes(1));
    const req = batch.mock.calls[0]![1];
    expect(req.source).toBe("cluster");
    expect(req.corrections.every((c) => c.kind === "accept" && c.detectionId && c.sheetId === "noah-eb8be8a3-p0")).toBe(true);
    expect(req.corrections.length).toBeGreaterThanOrEqual(Math.min(members, 3));
    // optimistic: the card leaves, the next item is active, the accepted items turn blue (✎ "אושר ידנית")
    expect(queue().querySelector(`[data-queue-item="${CSS.escape(id)}"]`)).toBeNull();
    expect(active()).not.toBeNull();
    const ids = new Set(req.corrections.map((c) => c.detectionId));
    await waitFor(() =>
      expect(
        markers()
          .filter((m) => ids.has(m.id))
          .every((m) => m.color?.[2] === 216),
      ).toBe(true),
    );
    await waitFor(() => expect(toasts().some((x) => /פריטים אושרו\.$/.test(x))).toBe(true));

    press("KeyZ", "ז");
    await waitFor(() => expect(revert).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queue().querySelector(`[data-queue-item="${CSS.escape(id)}"]`)).not.toBeNull(), LAZY);
    expect(toasts().some((x) => /^בוטל: /.test(x))).toBe(true);
    press("KeyZ", "ז", { shiftKey: true });
    await waitFor(() => expect(batch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toasts().some((x) => /^בוצע שוב: /.test(x))).toBe(true));
  });

  it("N / P move through the queue; R rejects a single item; E reclassifies via the picker and offers 'למד מהתיקון' → preview + slider → one batch", async () => {
    const user = userEvent.setup({ delay: null });
    const { api } = await open();
    const one = vi.spyOn(api, "createCorrection");
    const batch = vi.spyOn(api, "createCorrectionsBatch");
    const first = active()!.closest("[data-queue-item]")!.getAttribute("data-queue-item");
    press("KeyN", "מ");
    await waitFor(() => expect(active()!.closest("[data-queue-item]")!.getAttribute("data-queue-item")).not.toBe(first));
    press("KeyP", "פ");
    await waitFor(() => expect(active()!.closest("[data-queue-item]")!.getAttribute("data-queue-item")).toBe(first));

    await activate("detection");
    press("KeyR", "ר");
    await waitFor(() =>
      expect(one).toHaveBeenCalledWith("p-noah", expect.objectContaining({ kind: "reject", detectionId: expect.stringMatching(/^d_/) })),
    );

    await activate("detection");
    press("KeyE", "ק");
    const dlg = await screen.findByRole("dialog", { name: "שייך לסוג אחר" });
    await user.type(within(dlg).getByRole("combobox", { name: "חיפוש סוג" }), "שקע כח");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(one).toHaveBeenLastCalledWith("p-noah", expect.objectContaining({ kind: "reclassify", class: "socket_power" })));
    expect(toasts()).toContain("פריט אחד שויך ל'שקע כח'.");

    const offer = await screen.findByText("רוצה שאחפש סמלים דומים בכל הפרויקט?");
    await user.click(within(offer.closest("[data-learn-offer]") as HTMLElement).getByRole("button", { name: /מצא דומים/ }));
    const panel = await screen.findByRole("region", { name: "למד מהתיקון · שקע כח" });
    await within(panel).findByText(/^נמצאו \d+ דומים ב-\d+ גיליונות$/, undefined, LAZY);
    const counts = within(panel).getByTestId("learn-counts");
    const before = Number(/^(\d+) מעל הסף/.exec(counts.textContent!)![1]);
    fireEvent.change(within(panel).getByRole("slider"), { target: { value: "0.4" } });
    await waitFor(() => expect(Number(/^(\d+) מעל הסף/.exec(counts.textContent!)![1])).toBeGreaterThan(before));
    // exclude one thumbnail by hand
    await user.click(within(panel).getAllByRole("button", { name: /הוצא \/ החזר$/ })[0]!);
    const apply = within(panel).getByRole("button", { name: /^החל על \d+$/ });
    const n = Number(/\d+/.exec(apply.textContent!)![0]);
    await user.click(apply);
    await waitFor(() => expect(batch).toHaveBeenCalledTimes(1));
    const req = batch.mock.calls[0]![1];
    expect(req.source).toBe("similar");
    expect(req.corrections).toHaveLength(n);
    expect(
      req.corrections.every((c) => (c.kind === "reclassify" || c.kind === "accept") && c.class === "socket_power" && c.reason === "learned"),
    ).toBe(true);
    expect(toasts()).toContain(`${n} פריטים תוקנו בלמידה ל'שקע כח'.`);
    expect(screen.queryByRole("region", { name: /^למד מהתיקון/ })).toBeNull();
  });

  it("tools: + add (class picker → 'like last'), remove, move, link switch↔point, manual count / area → assigned to a BOQ item, lasso → batch", async () => {
    const user = userEvent.setup({ delay: null });
    const { api } = await open();
    const one = vi.spyOn(api, "createCorrection");
    const batch = vi.spyOn(api, "createCorrectionsBatch");
    // + (Shift+=) selects the add tool and asks for the class once
    press("Equal", "+", { shiftKey: true });
    await waitFor(() => expect(seen.props!.tool).toBe("add"));
    const pick = await screen.findByRole("dialog", { name: "איזה פריט להוסיף?" });
    await user.type(within(pick).getByRole("combobox"), "נק' TV");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => seen.props!.onPointTool!({ tool: "add", mm: [280, 100], hitId: null }));
    await waitFor(() =>
      expect(one).toHaveBeenLastCalledWith(
        "p-noah",
        expect.objectContaining({ kind: "add", class: "tv_point", roomId: "r_5", geometry: { type: "point", mm: [{ x: 280, y: 100 }] } }),
      ),
    );
    await waitFor(() => expect(markers().some((m) => m.id.startsWith("m_") && m.shape === "diamond")).toBe(true));
    expect(screen.getByRole("button", { name: /הוספה בלחיצה: נק' TV/ })).toBeInTheDocument();

    const target = markers().find((m) => !m.id.startsWith("m_") && !m.dashed)!;
    act(() => seen.props!.onPointTool!({ tool: "remove", mm: [target.position[0], target.position[1]], hitId: target.id }));
    await waitFor(() => expect(one).toHaveBeenLastCalledWith("p-noah", expect.objectContaining({ kind: "reject", detectionId: target.id })));
    const other = markers().find((m) => m.id !== target.id && !m.id.startsWith("m_"))!;
    act(() => seen.props!.onMove!({ id: other.id, fromMm: [other.position[0], other.position[1]], toMm: [100, 100] }));
    await waitFor(() =>
      expect(one).toHaveBeenLastCalledWith(
        "p-noah",
        expect.objectContaining({ kind: "move", detectionId: other.id, geometry: { type: "point", mm: [{ x: 100, y: 100 }] } }),
      ),
    );

    // manual count → "ספירה ידנית · 2 פריטים" → item 3.06
    act(() =>
      seen.props!.onCount!({
        pointsMm: [
          [150, 60],
          [160, 70],
        ],
      }),
    );
    const count = await screen.findByRole("dialog", { name: "ספירה ידנית · 2 פריטים" });
    await user.type(within(count).getByRole("combobox"), "3.06");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(one).toHaveBeenLastCalledWith(
        "p-noah",
        expect.objectContaining({
          kind: "count",
          itemCode: "3.06",
          quantity: 2,
          unit: "unit",
          geometry: {
            type: "point",
            mm: [
              { x: 150, y: 60 },
              { x: 160, y: 70 },
            ],
          },
        }),
      ),
    );
    await waitFor(() =>
      expect((seen.props!.overlays ?? []).filter((f) => f.kind === "point" && f.label).map((f) => (f as { label: string }).label)).toEqual([
        "1",
        "2",
      ]),
    );

    // area (m² at the sheet scale) → 5.02
    act(() =>
      seen.props!.onArea!({
        polygonMm: [
          [0, 0],
          [40, 0],
          [40, 30],
        ],
        paperMm2: 600,
        paperPerimeterMm: 120,
        areaM2: 1.5,
        perimeterM: 6,
      }),
    );
    const area = await screen.findByRole("dialog", { name: "מדידת שטח · 1.5 מ״ר" });
    await user.type(within(area).getByRole("combobox"), "5.02");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(one).toHaveBeenLastCalledWith(
        "p-noah",
        expect.objectContaining({
          kind: "measure",
          itemCode: "5.02",
          quantity: 1.5,
          unit: "m2",
          geometry: expect.objectContaining({ type: "polygon" }),
        }),
      ),
    );

    // lasso → card with the per-class summary → "אשר הכל" = one batch (source lasso)
    const ids = markers()
      .filter((m) => !m.dashed && !m.id.startsWith("m_"))
      .slice(0, 5)
      .map((m) => m.id);
    await user.keyboard("l");
    await waitFor(() => expect(seen.props!.tool).toBe("lasso"));
    act(() =>
      seen.props!.onLasso!({
        ids,
        polygonMm: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      }),
    );
    const card = await screen.findByRole("region", { name: /^נבחרו 5 פריטים$/ });
    expect(card).toHaveTextContent(/\(\d+ .+\)/);
    await user.click(within(card).getByRole("button", { name: "אשר הכל" }));
    await waitFor(() =>
      expect(batch).toHaveBeenLastCalledWith(
        "p-noah",
        expect.objectContaining({
          source: "lasso",
          corrections: expect.arrayContaining([expect.objectContaining({ kind: "accept", detectionId: ids[0] })]),
        }),
      ),
    );
    expect(batch.mock.lastCall![1].corrections).toHaveLength(5);
  });

  it("link tool: dragging from a switch to a point links them (or unlinks an existing link)", async () => {
    const { api } = await open({}, "/projects/p-noah/review?sheet=noah-b2046277-p0", /^שרטוט ת\. תאורה \/ קומת קרקע/, 40);
    const dets = await detections(api, "noah-b2046277-p0");
    const sw = dets.find((d) => d.class === "switch_single")!;
    const lum = dets.find((d) => d.class === "luminaire_ceiling")!;
    const one = vi.spyOn(api, "createCorrection");
    act(() => seen.props!.onLink!({ fromId: sw.id, toId: lum.id }));
    await waitFor(() =>
      expect(one).toHaveBeenCalledWith(
        "p-noah",
        expect.objectContaining({ kind: expect.stringMatching(/^(link|unlink)$/), switchIds: [sw.id], pointIds: [lum.id] }),
      ),
    );
    expect(toasts().some((x) => /^(קושר|הקישור נותק): מפסק\/מתג ← גוף תאורה תקרתי\.$/.test(x))).toBe(true);
    act(() => seen.props!.onLink!({ fromId: lum.id, toId: lum.id }));
    expect(toasts()).toContain("גררו ממפסק אל נקודת מאור.");
  });

  it("room panel: click a room → type, area / perimeter, cladding height, formula, partial cladding on a picked wall, waterproofing, waste → PUT room settings", async () => {
    const user = userEvent.setup({ delay: null });
    const { api } = await open();
    const put = vi.spyOn(api, "putRoomSettings");
    // "מקלחת" (r_5): 266..302 × 90..118 mm on the electrical fixture sheet
    act(() => seen.props!.onBackgroundClick!([280, 100]));
    const panel = await screen.findByRole("region", { name: "חדר: מקלחת" });
    expect(within(panel).getByRole("combobox", { name: "סוג חדר" })).toHaveValue("bathroom");
    expect(within(panel).getByText("חדר רטוב")).toBeInTheDocument();
    expect(within(panel).getByText("ברירת מחדל — עוד לא נשמר")).toBeInTheDocument();
    const h = within(panel).getByLabelText("גובה חיפוי (מ')");
    expect(h).toHaveValue(2.6);
    await user.clear(h);
    await user.type(h, "2.4");
    const formula = within(panel).getByTestId("cladding-formula");
    expect(formula).toHaveTextContent(/× 2\.4 מ׳ − 0 מ״ר פתחים = [\d.]+ מ״ר/);
    // partial cladding: pick a wall on the drawing (nearest wall to the click)
    await user.click(within(panel).getByRole("button", { name: "בחר קיר בשרטוט" }));
    await waitFor(() => expect((seen.props!.overlays ?? []).some((f) => f.id.startsWith("wall:"))).toBe(true));
    act(() => seen.props!.onBackgroundClick!([284, 90.5]));
    await waitFor(() => expect(panel.querySelectorAll("[data-partial]")).toHaveLength(1));
    const preview = within(panel).getByTestId("room-preview");
    expect(preview).toHaveTextContent("ריצוף");
    expect(preview).toHaveTextContent("חיפוי חלקי");
    expect(preview).toHaveTextContent("איטום");
    expect(await axe(panel)).toHaveNoViolations();
    await user.click(within(panel).getByRole("button", { name: "שמור הגדרות חדר" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [, sheetId, roomId, body] = put.mock.calls[0]!;
    expect([sheetId, roomId]).toEqual(["noah-eb8be8a3-p0", "r_5"]);
    expect(body).toMatchObject({
      claddingHeightM: 2.4,
      floorTiled: true,
      includeInWaterproofing: true,
      wasteFactor: 0.07,
      partialCladding: [expect.objectContaining({ wallId: expect.stringMatching(/^w_/), heightM: 1.2 })],
    });
    await waitFor(() => expect(toasts()).toContain("הגדרות החדר נשמרו. כתב הכמויות עודכן."));
    await waitFor(() => expect(within(panel).getByText("אושר ידנית")).toBeInTheDocument());
    await user.click(within(panel).getByRole("button", { name: "חזרה לתור" }));
    expect(screen.getByRole("region", { name: "תור בדיקה" })).toBeInTheDocument();
  });

  it("BOQ: tiling chapter with the 'כמות להזמנה' column; a manual count shows in the receipt as '+ N ידני'", async () => {
    const user = userEvent.setup({ delay: null });
    await open({ boqPrebuilt: true });
    await waitFor(() => expect(document.querySelector('tr[data-code="5.01"]')).not.toBeNull(), LAZY);
    const boq = screen.getByRole("region", { name: "כתב כמויות" });
    expect(within(boq).getByRole("columnheader", { name: /פרק 05 - עבודות ריצוף, חיפוי ואיטום/ })).toBeInTheDocument();
    const row501 = document.querySelector<HTMLElement>('tr[data-code="5.01"]')!;
    expect(row501).toHaveTextContent('מ"ר');
    await user.click(within(boq).getByRole("checkbox", { name: "כמות להזמנה" }));
    expect(within(boq).getByRole("columnheader", { name: "להזמנה" })).toBeInTheDocument();
    const qty = Number(
      within(row501)
        .getByRole("button", { name: /קבלה לשורה 5\.01/ })
        .textContent!.match(/[\d.]+/)![0],
    );
    const order = Number(row501.querySelector("[data-order-qty]")!.textContent);
    expect(order).toBeCloseTo(qty * 1.07, 1);
    act(() =>
      within(row501)
        .getByRole("button", { name: /קבלה לשורה 5\.01/ })
        .focus(),
    );
    const receipt = (await screen.findAllByText(/^[\d.]+ = [\d.]+ שזוהו$/))[0]!.closest("[data-receipt]")!;
    expect(receipt.querySelector("[data-receipt-breakdown]")).toHaveTextContent(/מקלחת/);
    expect(receipt).toHaveTextContent(/להזמנה \(פחת 7%\): [\d.]+/);

    // manual count of 2 garden taps → line 3.06: "2 = 0 שזוהו + 2 ידני"
    act(() =>
      seen.props!.onCount!({
        pointsMm: [
          [150, 60],
          [160, 70],
        ],
      }),
    );
    await user.type(within(await screen.findByRole("dialog", { name: "ספירה ידנית · 2 פריטים" })).getByRole("combobox"), "3.06");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.querySelector('tr[data-code="3.06"]')).not.toBeNull(), LAZY);
    act(() =>
      within(document.querySelector<HTMLElement>('tr[data-code="3.06"]')!)
        .getByRole("button", { name: /קבלה לשורה 3\.06/ })
        .focus(),
    );
    expect((await screen.findAllByText("2 = 0 שזוהו + 2 ידני"))[0]).toBeInTheDocument();
  });

  it("'?' opens the shortcut map; the queue, learn panel and lasso card are accessible (axe)", async () => {
    const user = userEvent.setup({ delay: null });
    await open();
    press("Slash", "?", { shiftKey: true });
    const help = await screen.findByRole("dialog", { name: "קיצורי מקלדת" });
    expect(within(help).getByText("אשר פריט / אשכול")).toBeInTheDocument();
    expect(await axe(help)).toHaveNoViolations();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "קיצורי מקלדת" })).toBeNull());
    expect(await axe(queue())).toHaveNoViolations();
    act(() =>
      seen.props!.onLasso!({
        ids: markers()
          .slice(0, 3)
          .map((m) => m.id),
        polygonMm: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      }),
    );
    await user.keyboard("l");
    const card = await screen.findByRole("region", { name: /^נבחרו 3 פריטים$/ });
    expect(await axe(card)).toHaveNoViolations();
  });
});
