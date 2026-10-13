import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DrawingViewerProps } from "@kamutan/viewer";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";
import type { Backend } from "@/api/types";

// jsdom has no WebGL: replace only the canvas with a stub that can emit a lasso, keep the rest of the package.
vi.mock("@kamutan/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kamutan/viewer")>();
  return {
    ...actual,
    DrawingViewer: (p: DrawingViewerProps) => (
      <div role="application" aria-label={p.ariaLabel} dir="ltr" data-tool={p.tool}>
        <span data-testid="stub-overlays">{(p.overlays ?? []).map((o) => o.id).join(",")}</span>
        <button
          type="button"
          onClick={() =>
            p.onLasso?.({
              polygonMm: [
                [10, 10],
                [100, 10],
                [100, 80],
                [10, 80],
              ],
              ids: [],
            })
          }
        >
          stub-lasso
        </button>
        <button
          type="button"
          onClick={() =>
            p.onCalibrate?.({ a: [0, 0], b: [40, 0], paperMm: 40, realMm: 1985, measured: 49.6, nearest: 50, relError: 0.008, snap: true, denominator: 50 })
          }
        >
          stub-calibrate
        </button>
      </div>
    ),
  };
});

const card = (name: RegExp | string) => screen.getByRole("article", { name });

async function openSheets(opts: Parameters<typeof renderApp>[1] = {}) {
  const r = await renderApp("/projects/p-noah/sheets", { signedIn: true, ...opts });
  await screen.findByRole("heading", { level: 1, name: "אישור גיליונות" });
  await screen.findByRole("article", { name: "ת. חשמל / קומת קרקע" });
  return r;
}

async function uploadAndFinalize(backend: Backend, projectId: string, filename: string) {
  const up = await backend.api.createUpload(projectId, { filename, sizeBytes: 5 });
  await new Promise<void>((resolve) => {
    const h = backend.uploads.start(up.storagePath, new File(["%PDF-"], filename), up.contentType, () => {});
    void h.done.then(resolve);
  });
  await act(async () => {
    await backend.api.finalizeUpload(projectId, { uploadToken: up.uploadToken });
  });
}

describe("Sheet confirmation (S07)", { timeout: 20_000 }, () => {
  it("shows a card per sheet with thumbnail, discipline, floors, scale and a confidence badge with reasons", async () => {
    await openSheets();
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(6);

    const elec = card("ת. חשמל / קומת מרתף+ / קומת קרקע");
    expect(within(elec).getByRole("combobox", { name: /תחום/ })).toHaveValue("electrical");
    expect(within(elec).getByRole("checkbox", { name: "מרתף" })).toBeChecked();
    expect(within(elec).getByRole("checkbox", { name: "קרקע" })).toBeChecked();
    expect(within(elec).getByRole("checkbox", { name: "קומה א'" })).not.toBeChecked();
    expect(within(elec).getByRole("textbox", { name: /מכנה קנה המידה/ })).toHaveValue("50");
    expect(within(elec).getByText("סביר")).toBeInTheDocument(); // yellow → ▲ סביר
    expect(within(elec).getByText("שתי קומות בגיליון אחד")).toBeInTheDocument();
    expect(within(elec).getByRole("button", { name: "פיצול לקומות" })).toBeInTheDocument();
    // thumbnail comes from the tiles manifest (dev artifacts URL in mock mode)
    const img = await within(elec).findByRole("img", { name: /תמונה ממוזערת/ });
    expect(img.getAttribute("src")).toMatch(/^\/dev-artifacts\/orgs\/org-demo\/projects\/p-noah\/sheets\/noah-c054fd3a-p0\/versions\/v1\/thumbnail\.webp$/);

    const demo = card("ת. הריסה / קומת קרקע");
    expect(within(demo).getByText("לבדיקה")).toBeInTheDocument(); // red → ◆ לבדיקה
    expect(within(demo).getByText("OCR נמוך")).toBeInTheDocument();
    // uncertain fields are marked (dashed + ◆ with an SR label)
    expect(within(demo).getAllByText("לא ודאי — כדאי לבדוק").length).toBeGreaterThanOrEqual(3);

    // already-confirmed sheet
    expect(within(card("ת. תאורה / קומת קרקע")).getAllByText("אושר").length).toBeGreaterThan(0);
    expect(screen.getByTestId("confirm-progress")).toHaveTextContent("1 מתוך 6 אושרו");
  });

  it("'אשר הכל' confirms every pending sheet through the API and the live listener reflects it", async () => {
    const user = userEvent.setup();
    const { backend } = await openSheets();
    const confirm = vi.spyOn(backend.api, "confirmSheet");
    await user.click(screen.getByRole("button", { name: "אשר הכל" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(5));
    expect(confirm).toHaveBeenCalledWith("p-noah", "noah-c054fd3a-p0", {
      discipline: "electrical",
      floors: ["basement", "ground"],
      scaleDenominator: 50,
    });
    expect(await screen.findByText("5 גיליונות אושרו.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("confirm-progress")).toHaveTextContent("6 מתוך 6 אושרו"));
    expect(screen.getByRole("button", { name: "אשר הכל" })).toBeDisabled();
  });

  it("inline edit: an incomplete sheet locks 'אשר הכל'; per-sheet confirm sends the edited values", async () => {
    const user = userEvent.setup();
    const { backend } = await openSheets();
    const confirm = vi.spyOn(backend.api, "confirmSheet");
    const plumb = card("ת. אינסטלציה / קומת מרתף");
    const scale = within(plumb).getByRole("textbox", { name: /מכנה קנה המידה/ });

    await user.clear(scale);
    expect(scale).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "אשר הכל" })).toBeDisabled();
    expect(screen.getByText("אפשר לאשר הכל אחרי שלכל גיליון יש תחום, קומה וקנה מידה.")).toBeInTheDocument();
    expect(within(plumb).getByRole("button", { name: /אשר את/ })).toBeDisabled();

    await user.type(scale, "100");
    await user.selectOptions(within(plumb).getByRole("combobox", { name: /תחום/ }), "tiling");
    await user.click(within(plumb).getByRole("checkbox", { name: "קרקע" }));
    expect(screen.getByRole("button", { name: "אשר הכל" })).toBeEnabled();
    await user.click(within(plumb).getByRole("button", { name: "אשר את ת. אינסטלציה / קומת מרתף" }));
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith("p-noah", "noah-24ab0ea0-p0", {
        discipline: "tiling",
        floors: ["basement", "ground"],
        scaleDenominator: 100,
      }),
    );
    await waitFor(() => expect(card("ת. אינסטלציה / קומת מרתף")).toHaveAttribute("data-status", "confirmed"));
  });

  it("'פיצול לקומות' opens the viewer: lasso adds a region, floors are editable, save PUTs the regions", async () => {
    const user = userEvent.setup();
    const { backend, baseElement } = await openSheets();
    const save = vi.spyOn(backend.api, "saveSheetRegions");
    await user.click(within(card("ת.תאורה / קומת מרתף+ / קומת קרקע")).getByRole("button", { name: "פיצול לקומות" }));
    const dialog = await screen.findByRole("dialog", { name: /פיצול לקומות/ });
    // seeded regions (2) are listed and drawn as passive overlays
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    expect(await within(dialog).findByTestId("stub-overlays", {}, { timeout: 10_000 })).toHaveTextContent("region:r1,region:r2");
    // lasso tool is active in split mode
    expect(within(dialog).getByRole("button", { name: "לאסו (L)" })).toHaveAttribute("aria-pressed", "true");

    await user.click(within(dialog).getByRole("button", { name: "stub-lasso" }));
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(3);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "קומה לאזור אזור 3" }), "roof");
    await user.click(within(dialog).getByRole("button", { name: "הסר את אזור 1" }));
    expect(await axe(baseElement)).toHaveNoViolations();
    await user.click(within(dialog).getByRole("button", { name: "שמור אזורים" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [, sheetId, regions] = save.mock.calls[0]!;
    expect(sheetId).toBe("noah-1bbe4113-p0");
    expect(regions.map((r) => [r.id, r.floor])).toEqual([
      ["r2", "first"],
      ["r3", "roof"],
    ]);
    expect(regions[1]!.polygonMm[1]).toEqual({ x: 100, y: 10 });
    expect(regions[1]!.scaleDenominator).toBe(50);
    expect(await screen.findByText("האזורים נשמרו.")).toBeInTheDocument();
    await waitFor(() => expect(within(card("ת.תאורה / קומת מרתף+ / קומת קרקע")).getAllByText("2 אזורים").length).toBeGreaterThan(0));
  });

  it("'כייל בשתי לחיצות' sets the card's scale from the calibration", async () => {
    const user = userEvent.setup();
    await openSheets();
    const plumb = card("ת. אינסטלציה / קומת מרתף");
    await user.clear(within(plumb).getByRole("textbox", { name: /מכנה קנה המידה/ }));
    await user.click(within(plumb).getByRole("button", { name: "כייל בשתי לחיצות" }));
    const dialog = await screen.findByRole("dialog", { name: /כיול קנה מידה/ });
    expect(within(dialog).getByRole("button", { name: "כיול קנה מידה (S)" })).toHaveAttribute("aria-pressed", "true");
    await user.click(await within(dialog).findByRole("button", { name: "stub-calibrate" }, { timeout: 10_000 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(card("ת. אינסטלציה / קומת מרתף")).getByRole("textbox", { name: /מכנה קנה המידה/ })).toHaveValue("50");
    expect(screen.getByText(/קנה המידה עודכן ל-/)).toBeInTheDocument();
  });

  it("shows live per-version progress after an upload, then the classified sheets", async () => {
    const { backend } = await renderApp("/projects/p-levi/sheets", { signedIn: true, jobTickMs: 30 });
    expect(await screen.findByText("עוד אין גיליונות. העלו סט שרטוטים בעמוד הפרויקט.")).toBeInTheDocument();
    await uploadAndFinalize(backend, "p-levi", "ת.חשמל קומת קרקע.pdf");

    // two pages → two cards, progressing through the worker stages
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    expect(await screen.findAllByRole("progressbar", { name: /התקדמות/ })).not.toHaveLength(0);
    await screen.findAllByText(/מכין את תצוגת הגיליון…|קורא את הטקסט בשרטוט…|קורא טבלאות כותרת…/, {}, { timeout: 3000 });

    await waitFor(() => expect(screen.getAllByRole("article").every((a) => a.getAttribute("data-status") === "ready")).toBe(true), {
      timeout: 5000,
    });
    const first = screen.getAllByRole("article")[0]!;
    expect(within(first).getByRole("combobox", { name: /תחום/ })).toHaveValue("electrical");
    expect(within(first).getByRole("checkbox", { name: "קרקע" })).toBeChecked();
  });

  it("has no axe violations", async () => {
    const { container } = await openSheets();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Processing panel (project page): per-sheet stage and Hebrew errors", () => {
  it("lists each sheet's stage while processing and a Hebrew message for a failed page", async () => {
    const { backend } = await renderApp("/projects/p-levi", { signedIn: true, jobTickMs: 30 });
    await screen.findByRole("heading", { level: 1, name: /דירת לוי/ });
    await uploadAndFinalize(backend, "p-levi", "broken-set.pdf");

    const section = await screen.findByRole("region", { name: "התקדמות לפי גיליון" });
    await waitFor(() => expect(section.querySelectorAll("[data-sheet-progress]")).toHaveLength(2));
    await within(section).findAllByText(/עמוד 1|עמוד 2/);
    // page 2 fails during OCR → Hebrew error, the rest of the set completes
    expect(await screen.findByText("לא הצלחנו להכין את תצוגת הגיליון.", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "אישור גיליונות" }, { timeout: 5000 })).toHaveAttribute("href", "/projects/p-levi/sheets");
    expect(screen.getByText("גיליון אחד מחכה לאישור")).toBeInTheDocument();
  });

  it("names each job row by its own sheet set (version ids repeat across sets)", async () => {
    const { backend } = await renderApp("/projects/p-levi", { signedIn: true, jobTickMs: 10_000 });
    await screen.findByRole("heading", { level: 1, name: /דירת לוי/ });
    await uploadAndFinalize(backend, "p-levi", "a-חשמל.pdf");
    await uploadAndFinalize(backend, "p-levi", "b-תאורה.pdf");
    const jobs = await screen.findByRole("region", { name: "עיבוד" });
    await waitFor(() => expect(jobs.querySelectorAll("[data-job]")).toHaveLength(2));
    expect(within(jobs).getByText("a-חשמל.pdf")).toBeInTheDocument();
    expect(within(jobs).getByText("b-תאורה.pdf")).toBeInTheDocument();
  });

  it("shows the job error when the whole file fails (encrypted PDF)", async () => {
    const { backend, container } = await renderApp("/projects/p-levi", { signedIn: true, jobTickMs: 10 });
    await screen.findByRole("heading", { level: 1, name: /דירת לוי/ });
    await uploadAndFinalize(backend, "p-levi", "encrypted.pdf");
    expect((await screen.findAllByText("הקובץ מוגן בסיסמה. שמרו אותו בלי הצפנה והעלו שוב.", {}, { timeout: 3000 })).length).toBeGreaterThan(0);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("tool rail keyboard", { timeout: 20_000 }, () => {
  it("switches tools by physical key (works on a Hebrew layout)", async () => {
    const user = userEvent.setup();
    await openSheets();
    await user.click(within(card("ת.תאורה / קומת מרתף+ / קומת קרקע")).getByRole("button", { name: "פיצול לקומות" }));
    const dialog = await screen.findByRole("dialog");
    const app = await within(dialog).findByRole("application", {}, { timeout: 10_000 });
    fireEvent.keyDown(app, { code: "KeyV", key: "ה" });
    expect(within(dialog).getByRole("button", { name: "בחירה (V)" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(app, { code: "KeyD", key: "ג" });
    expect(within(dialog).getByRole("button", { name: "מדידת אורך (D)" })).toHaveAttribute("aria-pressed", "true");
  });
});
