import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DrawingViewerProps } from "@kamutan/viewer";
import { Providers, makeQueryClient } from "@/App";
import { createMockBackend } from "@/api/mock";
import type { ApiClient } from "@/api/types";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";
import { useToastStore } from "@/components/ui/toast";
import { ShareDialog } from "./ShareDialog";

const seen: { props: DrawingViewerProps | null } = { props: null };
vi.mock("@kamutan/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kamutan/viewer")>();
  return {
    ...actual,
    DrawingViewer: (p: DrawingViewerProps) => {
      if (p) seen.props = p;
      return <div role="application" aria-label={p?.ariaLabel} dir="ltr" data-watermark={p?.watermark ?? undefined} />;
    },
  };
});
const WAIT = { timeout: 20_000 };
beforeAll(async () => {
  await import("./SharedViewerPage");
  await import("./SharedDrawing");
}, 60_000);
const toasts = () => useToastStore.getState().items.map((t) => t.title);

function renderDialog(opts: { canManage?: boolean } = {}) {
  const backend = createMockBackend({ latencyMs: 0, jobTickMs: 5, devIndex: false });
  const onOpenChange = vi.fn();
  useToastStore.setState({ items: [] });
  render(
    <Providers backend={backend} queryClient={makeQueryClient()}>
      <ShareDialog projectId="p-noah" open onOpenChange={onOpenChange} canManage={opts.canManage ?? true} />
    </Providers>,
  );
  return { backend, onOpenChange };
}

describe("Share dialog (S12, FR-30)", { timeout: 30_000 }, () => {
  it("defaults: 14 days, hide title block ON, allow PDF OFF; label required; days 1..90", async () => {
    const user = userEvent.setup({ delay: null });
    renderDialog();
    const dlg = await screen.findByRole("dialog", { name: "שיתוף לצפייה בלבד" });
    expect(within(dlg).getByLabelText("תוקף בימים")).toHaveValue(14);
    expect(within(dlg).getByLabelText(/הסתר את טבלת הכותרת/)).toBeChecked();
    expect(within(dlg).getByLabelText("אפשר להוריד PDF מסומן")).not.toBeChecked();
    await user.click(within(dlg).getByRole("button", { name: "צור קישור" }));
    expect(within(dlg).getByText("חובה לתת שם לקישור.")).toBeInTheDocument();
    const days = within(dlg).getByLabelText("תוקף בימים");
    await user.clear(days);
    await user.type(days, "120");
    expect(within(dlg).getByText("התוקף חייב להיות בין 1 ל-90 יום.")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "30" }));
    expect(days).toHaveValue(30);
  });

  it("creates a link, shows the URL ONCE with copy, lists it with expiry / views; revoke asks to confirm", async () => {
    const user = userEvent.setup({ delay: null });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { backend } = renderDialog();
    const create = vi.spyOn(backend.api, "createShareLink");
    const dlg = await screen.findByRole("dialog", { name: "שיתוף לצפייה בלבד" });
    // seeded links: active / expired / revoked
    await waitFor(() => expect(dlg.querySelectorAll("[data-link]").length).toBe(3));
    expect(dlg.querySelector('[data-state="expired"]')).toHaveTextContent("פג תוקף");
    expect(dlg.querySelector('[data-state="revoked"]')).toHaveTextContent("בוטל");
    expect(dlg.querySelector('[data-state="active"]')).toHaveTextContent("נצפה 3 פעמים");

    await user.type(within(dlg).getByLabelText("שם הקישור"), "קבלן חשמל");
    await user.type(within(dlg).getByLabelText("נמען (לא חובה)"), "יוסי");
    await user.click(within(dlg).getByRole("button", { name: "7" }));
    await user.click(within(dlg).getByLabelText("אפשר להוריד PDF מסומן"));
    await user.click(within(dlg).getByRole("button", { name: "צור קישור" }));
    expect(create).toHaveBeenCalledWith("p-noah", { days: 7, label: "קבלן חשמל", recipient: "יוסי", hideTitleBlock: true, allowPdfDownload: true });
    const url = (await within(dlg).findByLabelText("קישור הצפייה")) as HTMLInputElement;
    expect(url.value).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/);
    expect(url).toHaveAttribute("dir", "ltr");
    expect(within(dlg).getByText(/זו הפעם היחידה שהקישור מוצג/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "העתק קישור" }));
    expect(writeText).toHaveBeenCalledWith(url.value);
    await waitFor(() => expect(toasts().some((x) => /^הקישור הועתק\. בתוקף עד \d\d\.\d\d\.\d{4}\.$/.test(x))).toBe(true));
    await waitFor(() => expect(dlg.querySelectorAll("[data-link]").length).toBe(4));
    const token = url.value.split("/s/")[1]!;
    expect(dlg.querySelector("[data-share-list]")!.textContent).not.toContain(token);

    // "another link" drops the raw URL from the screen
    await user.click(within(dlg).getByRole("button", { name: "צור קישור נוסף" }));
    expect(within(dlg).queryByLabelText("קישור הצפייה")).toBeNull();

    // revoke → confirm dialog (spec copy) → immediate
    const newest = dlg.querySelector<HTMLElement>("[data-share-list] [data-link]")!;
    await user.click(within(newest).getByRole("button", { name: "בטל את הקישור קבלן חשמל" }));
    const confirm = await screen.findByRole("alertdialog", { name: "לבטל את הקישור?" });
    expect(confirm).toHaveTextContent("מי שיפתח אותו יראה הודעה שהוא לא פעיל. אי אפשר להחזיר אותו, אבל אפשר ליצור קישור חדש.");
    await user.click(within(confirm).getByRole("button", { name: "בטל קישור" }));
    await waitFor(() => expect(dlg.querySelector("[data-share-list] [data-link]")).toHaveAttribute("data-state", "revoked"));
    await expect(backend.publicShare.getMeta(token)).rejects.toMatchObject({ status: 410, code: "share_revoked" });
  });

  it("reviewers / viewers see the list but no create or revoke", async () => {
    renderDialog({ canManage: false });
    const dlg = await screen.findByRole("dialog", { name: "שיתוף לצפייה בלבד" });
    expect(within(dlg).getByText("רק עורכים ומנהלים יכולים ליצור ולבטל קישורי שיתוף.")).toBeInTheDocument();
    await waitFor(() => expect(dlg.querySelectorAll("[data-link]").length).toBe(3));
    expect(within(dlg).queryByRole("button", { name: /^צור קישור|^בטל/ })).toBeNull();
  });

  it("is accessible (axe)", async () => {
    renderDialog();
    const dlg = await screen.findByRole("dialog", { name: "שיתוף לצפייה בלבד" });
    await waitFor(() => expect(dlg.querySelectorAll("[data-link]").length).toBe(3));
    expect(await axe(dlg)).toHaveNoViolations();
  });
});

const MEMBER_API_METHODS = (api: ApiClient) => Object.keys(api) as (keyof ApiClient)[];

describe("External viewer /s/:token (S15, E2E-09)", { timeout: 40_000 }, () => {
  it("no sign-in; BOQ + drawing; read-only; no member API call; watermark; noindex + no-referrer", async () => {
    const user = userEvent.setup({ delay: null });
    const spies: ReturnType<typeof vi.spyOn>[] = [];
    await renderApp("/s/demo-noah", {
      boqPrebuilt: true,
      devIndex: false,
      onBackend: (b) => {
        for (const k of MEMBER_API_METHODS(b.api)) spies.push(vi.spyOn(b.api, k));
      },
    });
    const viewer = await screen.findByRole("heading", { level: 1, name: /בית משפחת נח/ }, WAIT);
    expect(viewer).toHaveTextContent("סטודיו נח לעיצוב פנים · בית משפחת נח");
    expect(screen.getByText("לקריאה בלבד")).toBeInTheDocument();
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
    expect(document.head.querySelector('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
    // PDF allowed on this link → a plain download link without referrer
    const pdf = screen.getByRole("link", { name: "הורד PDF מסומן" });
    expect(pdf).toHaveAttribute("rel", expect.stringContaining("noreferrer"));

    await waitFor(() => expect(document.querySelectorAll("tr[data-line]").length).toBeGreaterThan(5), WAIT);
    const canvas = await screen.findByRole("application", {}, WAIT);
    expect(canvas).toHaveAttribute("dir", "ltr"); // only the drawing is LTR (the app shell is dir=rtl)
    expect(canvas).toHaveAttribute("data-watermark", expect.stringMatching(/^שותף עם יוסי אלקטריק • \d\d\.\d\d\.\d{4} • /));
    // drawing is select-only: no tool rail, no correction / measure / calibrate callbacks
    const p = seen.props!;
    expect(p.tool).toBe("select");
    for (const k of ["onToolChange", "onPointTool", "onMove", "onLink", "onCount", "onArea", "onLength", "onLasso", "onMeasure", "onCalibrate", "onBackgroundClick"] as const) expect(p[k]).toBeUndefined();

    // no edit affordances anywhere: the only buttons select lines
    const buttons = screen.getAllByRole("button");
    for (const b of buttons) expect(b).toHaveAccessibleName(/^הצג את /);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();

    // row → drawing: the line's evidence is focused (switches to the sheet holding it)
    const lineRow = await waitFor(() => {
      const r = [...document.querySelectorAll<HTMLTableRowElement>("tr[data-line]")].find((x) => x.dataset.line && x.querySelector("bdi")?.textContent === "4.01");
      expect(r).toBeTruthy();
      return r!;
    }, WAIT);
    await user.click(within(lineRow).getByRole("button"));
    await waitFor(() => expect(seen.props!.focusIds!.length).toBeGreaterThan(0), WAIT);
    expect(within(lineRow).getByRole("button")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/פריטים בגיליון/)).toBeInTheDocument();
    // drawing → row
    const det = seen.props!.focusIds![0]!;
    await user.click(within(lineRow).getByRole("button")); // unselect
    await waitFor(() => expect(within(lineRow).getByRole("button")).toHaveAttribute("aria-pressed", "false"));
    act(() => seen.props!.onSelect!([det], { additive: false }));
    await waitFor(() => expect(within(lineRow).getByRole("button")).toHaveAttribute("aria-pressed", "true"));

    // not a single member-API call from this route (only the public GET client)
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it.each([
    ["/s/demo-expired", "expired", "הקישור פג תוקף", "הקישור כבר לא פעיל."],
    ["/s/demo-revoked", "revoked", "הקישור בוטל", "הקישור כבר לא פעיל."],
    ["/s/not-a-real-token", "not_found", "הקישור לא נמצא", "בדקו שהעתקתם את הקישור במלואו."],
  ])("%s → %s screen", async (path, kind, title, body) => {
    await renderApp(path, { devIndex: false });
    expect(await screen.findByRole("heading", { name: title }, WAIT)).toBeInTheDocument();
    expect(document.querySelector(`[data-share-state="${kind}"]`)).toBeTruthy();
    expect(screen.getByText(new RegExp(body.replace(".", "\\.")))).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("a link revoked while open → the next request shows 'הקישור בוטל'", async () => {
    const { backend } = await renderApp("/s/demo-noah", { boqPrebuilt: true, devIndex: false });
    await screen.findByRole("heading", { level: 1, name: /בית משפחת נח/ }, WAIT);
    const id = (await backend.api.listShareLinks("p-noah")).find((l) => l.label.startsWith("קבלן חשמל"))!.id;
    await backend.api.revokeShareLink("p-noah", id);
    await expect(backend.publicShare.getBoq("demo-noah")).rejects.toMatchObject({ status: 410 });
  });

  it("is accessible (axe) with the BOQ loaded", async () => {
    await renderApp("/s/demo-noah", { boqPrebuilt: true, devIndex: false });
    await waitFor(() => expect(document.querySelectorAll("tr[data-line]").length).toBeGreaterThan(5), WAIT);
    expect(await axe(document.querySelector("[data-share-viewer]")!)).toHaveNoViolations();
  });
});
