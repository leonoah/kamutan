import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "@/test/axe";
import { DXF_BYTES, PDF_BYTES, PNG_BYTES, makeFile, renderApp } from "@/test/utils";
import { MAX_FILE_BYTES } from "./validation";

const openProject = async () => {
  const r = await renderApp("/projects/p-levi", { signedIn: true });
  await screen.findByRole("heading", { level: 1, name: /דירת לוי/ });
  return r;
};

function bigFile(name: string) {
  const f = makeFile(name, PDF_BYTES);
  Object.defineProperty(f, "size", { value: MAX_FILE_BYTES + 1 });
  return f;
}

describe("Upload dropzone", () => {
  it("uploads multiple files with per-file progress, then saves the set", async () => {
    const user = userEvent.setup();
    await openProject();
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    await user.upload(input, [makeFile("ת.חשמל.pdf", PDF_BYTES), makeFile("plan.dxf", DXF_BYTES)]);

    const list = await screen.findByRole("list", { name: "קבצים בהעלאה" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await waitFor(() => expect(within(list).getAllByText("הועלה")).toHaveLength(2), { timeout: 3000 });
    expect(screen.getByText("2 מתוך 2 הועלו")).toBeInTheDocument();
    expect(within(list).getAllByRole("progressbar")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "שמירת הסט והתחלת עיבוד" }));
    expect(await screen.findByText("הסט נשמר (2 קבצים). העיבוד התחיל.")).toBeInTheDocument();
  });

  it("rejects unsupported, oversize and mismatched files with Hebrew errors", async () => {
    await openProject();
    const zone = screen.getByTestId("dropzone");
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [makeFile("plan.rvt", "x"), bigFile("huge.pdf"), makeFile("fake.pdf", "PK\x03\x04")],
      },
    });
    const alerts = await screen.findAllByRole("alert");
    const texts = alerts.map((a) => a.textContent);
    expect(texts).toContain("אי אפשר לקרוא את הקובץ ⁨plan.rvt⁩. אפשר להעלות PDF, DWG, DXF או PNG.");
    expect(texts.some((t) => t?.startsWith("הקובץ גדול מ-⁨100MB⁩."))).toBe(true);
    expect(texts).toContain("תוכן הקובץ ⁨fake.pdf⁩ לא תואם לסיומת שלו.");
    expect(screen.getAllByText("נדחה")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "שמירת הסט והתחלת עיבוד" })).toBeDisabled();
  });

  it("flags PNG as raster and marks duplicates", async () => {
    const user = userEvent.setup();
    await openProject();
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    await user.upload(input, [makeFile("scan.png", PNG_BYTES)]);
    expect(await screen.findByText("רסטר — ביטחון מרבי 'סביר'")).toBeInTheDocument();
    await user.upload(input, [makeFile("scan.png", PNG_BYTES)]);
    expect(await screen.findByText("הקובץ ⁨scan.png⁩ כבר ברשימה.")).toBeInTheDocument();
  });

  it("shows a retry action when the network fails", async () => {
    const user = userEvent.setup();
    await openProject();
    await user.upload(screen.getByTestId("file-input") as HTMLInputElement, [makeFile("will-fail.pdf", PDF_BYTES)]);
    expect(await screen.findByText("ההעלאה נכשלה. בדקו את החיבור ונסו שוב.", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "נסו שוב" })).toBeInTheDocument();
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

  it("project page with an upload list has no axe violations", async () => {
    const user = userEvent.setup();
    const { container } = await openProject();
    await user.upload(screen.getByTestId("file-input") as HTMLInputElement, [
      makeFile("a.pdf", PDF_BYTES),
      makeFile("b.png", PNG_BYTES),
    ]);
    await screen.findByRole("list", { name: "קבצים בהעלאה" });
    expect(await axe(container)).toHaveNoViolations();
  });
});
