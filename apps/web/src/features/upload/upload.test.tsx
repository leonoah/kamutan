import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "@/test/axe";
import { DXF_BYTES, PDF_BYTES, PNG_BYTES, makeFile, renderApp } from "@/test/utils";
import { MAX_FILE_BYTES } from "./validation";

const openProject = async (opts: Parameters<typeof renderApp>[1] = {}) => {
  const r = await renderApp("/projects/p-levi", { signedIn: true, ...opts });
  await screen.findByRole("heading", { level: 1, name: /דירת לוי/ });
  // IA v2: once a project has drawings, upload is a secondary action in a dialog (no inline dropzone).
  await waitFor(() =>
    expect(screen.queryByTestId("file-input") ?? screen.queryByRole("button", { name: "העלאת שרטוטים" })).toBeTruthy(),
  );
  if (!screen.queryByTestId("file-input")) {
    fireEvent.click(screen.getByRole("button", { name: "העלאת שרטוטים" }));
    await screen.findByTestId("file-input");
  }
  return r;
};

function bigFile(name: string) {
  const f = makeFile(name, PDF_BYTES);
  Object.defineProperty(f, "size", { value: MAX_FILE_BYTES + 1 });
  return f;
}

const row = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

describe("Upload dropzone (resumable → finalize → live processing)", () => {
  it("uploads several files, finalizes each, and shows the ingest job progressing live", async () => {
    const user = userEvent.setup();
    const { backend } = await openProject();
    const createUpload = vi.spyOn(backend.api, "createUpload");
    const finalize = vi.spyOn(backend.api, "finalizeUpload");
    const start = vi.spyOn(backend.uploads, "start");

    await user.upload(screen.getByTestId("file-input"), [makeFile("ת.חשמל.pdf", PDF_BYTES), makeFile("plan.dxf", DXF_BYTES)]);

    const list = await screen.findByRole("list", { name: "קבצים בהעלאה" });
    await waitFor(() => expect(within(list).getAllByText("הועלה")).toHaveLength(2), { timeout: 3000 });
    expect(screen.getByText("2 מתוך 2 הועלו")).toBeInTheDocument();

    // Contract: POST /uploads → Storage at the API-issued path with its contentType → POST /sheet-sets with the token.
    expect(createUpload).toHaveBeenCalledWith("p-levi", { filename: "plan.dxf", sizeBytes: DXF_BYTES.length });
    const [path, , contentType] = start.mock.calls.find((c) => (c[1] as File).name === "plan.dxf")!;
    expect(path).toMatch(/^orgs\/org-demo\/uploads\/mock-user\/f-/);
    expect(contentType).toBe("application/dxf");
    expect(finalize).toHaveBeenCalledWith("p-levi", expect.objectContaining({ uploadToken: expect.stringMatching(/^mock-token-/) }));

    expect(await screen.findAllByText(/הועלה\. העיבוד התחיל\./)).toHaveLength(2);
    // Live sheetSets listener → both sets reach "מוכן".
    const sets = await screen.findByRole("list", { name: "סטים שהועלו" });
    await waitFor(() => expect(within(sets).getAllByText(/^מוכן/)).toHaveLength(2), { timeout: 3000 });
  });

  it("pauses, resumes and cancels a single file", async () => {
    const user = userEvent.setup();
    await openProject({ uploadTickMs: 40 });
    await user.upload(screen.getByTestId("file-input"), [makeFile("big.pdf", PDF_BYTES), makeFile("other.png", PNG_BYTES)]);

    const pauseBtn = await screen.findByRole("button", { name: "השהיית ההעלאה של big.pdf" });
    await user.click(pauseBtn);
    expect(within(row("big.pdf")).getByText("מושהה")).toBeInTheDocument();
    const pausedAt = row("big.pdf").getAttribute("data-status");
    expect(pausedAt).toBe("paused");

    await user.click(screen.getByRole("button", { name: "המשך ההעלאה של big.pdf" }));
    await waitFor(() => expect(row("big.pdf")).toHaveAttribute("data-status", "uploading"));

    await user.click(screen.getByRole("button", { name: "ביטול ההעלאה של big.pdf" }));
    expect(within(row("big.pdf")).getByText("בוטל")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "נסו שוב" })).toBeInTheDocument();

    // The other file is unaffected and completes.
    await waitFor(() => expect(row("other.png")).toHaveAttribute("data-status", "done"), { timeout: 10_000 });
    expect(row("big.pdf")).toHaveAttribute("data-status", "canceled");
    // Real-time upload ticks: generous budget so a loaded CI runner (turbo runs suites in parallel) doesn't flake.
  }, 20_000);

  it("rejects unsupported, oversize and mismatched files with Hebrew errors (no API calls)", async () => {
    const { backend } = await openProject();
    const createUpload = vi.spyOn(backend.api, "createUpload");
    const zone = screen.getByTestId("dropzone");
    await act(async () => {
      fireEvent.drop(zone, {
        dataTransfer: { files: [makeFile("plan.rvt", "x"), bigFile("huge.pdf"), makeFile("fake.pdf", "PK\x03\x04")] },
      });
    });
    const texts = (await screen.findAllByRole("alert")).map((a) => a.textContent);
    expect(texts).toContain("אי אפשר לקרוא את הקובץ ⁨plan.rvt⁩. אפשר להעלות PDF, DWG, DXF או PNG.");
    expect(texts.some((t) => t?.startsWith("הקובץ גדול מ-⁨100MB⁩."))).toBe(true);
    expect(texts).toContain("תוכן הקובץ ⁨fake.pdf⁩ לא תואם לסיומת שלו.");
    expect(screen.getAllByText("נדחה")).toHaveLength(3);
    expect(createUpload).not.toHaveBeenCalled();
  });

  it("flags PNG as raster and marks duplicates", async () => {
    const user = userEvent.setup();
    await openProject();
    const input = screen.getByTestId("file-input");
    await user.upload(input, [makeFile("scan.png", PNG_BYTES)]);
    expect(await screen.findByText("רסטר — ביטחון מרבי 'סביר'")).toBeInTheDocument();
    await user.upload(input, [makeFile("scan.png", PNG_BYTES)]);
    expect(await screen.findByText("הקובץ ⁨scan.png⁩ כבר ברשימה.")).toBeInTheDocument();
  });

  it("shows a retry action when the transfer fails, and retry succeeds with a fresh upload slot", async () => {
    const user = userEvent.setup();
    const { backend } = await openProject();
    await user.upload(screen.getByTestId("file-input"), [makeFile("will-fail.pdf", PDF_BYTES)]);
    expect(await screen.findByText("ההעלאה נכשלה. בדקו את החיבור ונסו שוב.", {}, { timeout: 3000 })).toBeInTheDocument();
    const createUpload = vi.spyOn(backend.api, "createUpload");
    const original = backend.uploads.start.bind(backend.uploads);
    // Second attempt: "the network is back" (the mock only fails names containing "fail").
    vi.spyOn(backend.uploads, "start").mockImplementationOnce((path, _file, ct, onProgress) =>
      original(path, makeFile("ok.pdf", PDF_BYTES), ct, onProgress),
    );
    await user.click(screen.getByRole("button", { name: "נסו שוב" }));
    await waitFor(() => expect(row("will-fail.pdf")).toHaveAttribute("data-status", "done"), { timeout: 3000 });
    expect(createUpload).toHaveBeenCalledTimes(1);
  });

  it("highlights while dragging", async () => {
    await openProject();
    const zone = screen.getByTestId("dropzone");
    fireEvent.dragEnter(zone, { dataTransfer: { files: [] } });
    expect(zone).toHaveAttribute("data-dragging", "true");
    expect(screen.getByText("שחררו כדי להעלות")).toBeInTheDocument();
    fireEvent.dragLeave(zone);
    expect(zone).not.toHaveAttribute("data-dragging");
  });

  it("project page with uploads and live processing has no axe violations", async () => {
    const user = userEvent.setup();
    const { container } = await openProject({ uploadTickMs: 30, jobTickMs: 200 });
    await user.upload(screen.getByTestId("file-input"), [makeFile("a.pdf", PDF_BYTES), makeFile("b.png", PNG_BYTES)]);
    await screen.findByRole("list", { name: "קבצים בהעלאה" });
    await screen.findByRole("region", { name: "עיבוד" }, { timeout: 3000 });
    expect(await axe(container)).toHaveNoViolations();
  });
});
