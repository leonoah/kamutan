import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n";
import { Providers, makeQueryClient } from "@/App";
import { createMockBackend } from "@/api/mock";
import { CONSERVATIVE_REASON, type BoqLine, type SheetRow } from "@/api/types";
import { axe } from "@/test/axe";
import { ReasonChip } from "@/components/ReasonChip";
import { useToastStore } from "@/components/ui/toast";
import { ExportDialog } from "@/features/boq/ExportDialog";
import { CalibrationBadge, cappedLines, resolveCalibration } from "@/features/calibration/CalibrationBadge";
import { ScoreText } from "@/features/review/DetectionDetails";
import { LineHistoryDialog, describeChange } from "./LineHistoryDialog";

const PID = "p-noah";
const WAIT = { timeout: 15_000 };

async function setup() {
  const backend = createMockBackend({ latencyMs: 0, jobTickMs: 5, devIndex: false, boqPrebuilt: true });
  for (let i = 0; i < 200 && (await backend.api.listBoqLines(PID)).items.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  const lines = (await backend.api.listBoqLines(PID)).items;
  const rows = await new Promise<SheetRow[]>((r) => backend.realtime.sheets("org-demo", PID, r, () => {}));
  useToastStore.setState({ items: [] });
  return { backend, lines, rows: rows.filter((x) => x.version?.status === "ready") };
}
const wrap = (backend: ReturnType<typeof createMockBackend>, ui: React.ReactNode) =>
  render(<Providers backend={backend} queryClient={makeQueryClient()}>{ui}</Providers>);

describe("Calibration badge 'כיול שמרני' (brief §1)", () => {
  it("persistent badge with an explainer popover; hidden in full mode; unknown = conservative", async () => {
    const user = userEvent.setup({ delay: null });
    const { backend, lines } = await setup();
    const cal = resolveCalibration(null, []);
    expect(cal).toMatchObject({ mode: "conservative", known: false });
    const { rerender } = wrap(backend, <CalibrationBadge calibration={{ mode: "conservative", version: "cal-2026.10" }} capped={cappedLines(lines)} greenThreshold={0.98} />);
    const badge = screen.getByRole("button", { name: "מצב כיול שמרני — מה זה אומר?" });
    expect(badge).toHaveTextContent("כיול שמרני");
    await user.click(badge);
    const pop = await screen.findByRole("dialog", { name: "המערכת רצה בכיול שמרני" });
    expect(pop).toHaveTextContent("200 פריטים לפחות בלי אף טעות");
    expect(pop).toHaveTextContent("לכל היותר 'סביר'");
    expect(pop).toHaveTextContent(/\d+ שורות בכתב הכמויות הוגבלו ל'סביר'/);
    expect(within(pop).getByText("cal-2026.10").tagName).toBe("BDI");
    expect(within(pop).getByText("0.98")).toBeInTheDocument();
    expect(await axe(pop)).toHaveNoViolations();
    rerender(<Providers backend={backend} queryClient={makeQueryClient()}><CalibrationBadge calibration={{ mode: "full", version: "x" }} /></Providers>);
    expect(screen.queryByRole("button", { name: /כיול שמרני/ })).toBeNull();
  });

  it("reason chip shows 'כיול שמרני' with the worker's explanation as the hint; detection card shows the calibrated score", () => {
    render(
      <>
        <ReasonChip code={CONSERVATIVE_REASON} />
        <ReasonChip code="CONSERVATIVE_CALIBRATION" />
        <ReasonChip code="NOT_IN_LEGEND" />
        <ScoreText d={{ score: 0.83, scoreRaw: 0.91 }} />
        <ScoreText d={{ score: 0.5 }} />
      </>,
    );
    const chips = document.querySelectorAll('[data-reason="CONSERVATIVE_CALIBRATION"]');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent(/^כיול שמרני$/);
    expect(chips[0]).toHaveAttribute("title", "אין מספיק נתוני אמת לסוג זה");
    expect(chips[1]).toHaveAttribute("title", i18n.t("reasonHints.CONSERVATIVE_CALIBRATION"));
    expect(screen.getByText("סמל לא במקרא")).toBeInTheDocument();
    expect(document.querySelector('[data-score-calibrated="0.83"]')).toHaveTextContent("ביטחון מכויל 0.83 · לפני כיול 0.91");
    expect(document.querySelector('[data-score-calibrated="0.50"]')).toHaveTextContent(/^ביטחון 0\.50$/);
  });
});

describe("Line history (S13, FR-26, E2E-11)", () => {
  it("before/after, who, when, Hebrew action labels and the override reason; approved → נבדק noted", async () => {
    const { backend, lines } = await setup();
    const l = lines.find((x) => x.code === "4.02")!;
    await backend.api.patchBoqLine(PID, l.id, { status: "reviewed" });
    await backend.api.patchBoqLine(PID, l.id, { status: "approved" });
    await backend.api.patchBoqLine(PID, l.id, { qtyOverride: l.qty + 2, reason: "2 שקעים נוספים לפי שיחה עם הלקוח" });
    wrap(backend, <LineHistoryDialog projectId={PID} line={l} open onOpenChange={() => {}} />);
    const dlg = await screen.findByRole("dialog", { name: /היסטוריית שינויים · 4\.02/ });
    await waitFor(() => expect(dlg.querySelectorAll("[data-history] li").length).toBeGreaterThanOrEqual(5), WAIT);
    const items = [...dlg.querySelectorAll<HTMLElement>("[data-history] li")];
    expect(items.map((i) => i.dataset.action)).toEqual(expect.arrayContaining(["qtyOverride", "status", "rebuild"]));
    const over = items.find((i) => i.dataset.action === "qtyOverride")!;
    expect(over).toHaveTextContent("שינוי כמות ידני");
    expect(over).toHaveTextContent(`לפני: ${l.qty}`);
    expect(over).toHaveTextContent(`אחרי: ${l.qty + 2}`);
    expect(over).toHaveTextContent("נימוק: 2 שקעים נוספים לפי שיחה עם הלקוח");
    expect(over).toHaveTextContent(/דנה כהן · \d\d\.\d\d\.\d{4} \d\d:\d\d/);
    const reopened = items.find((i) => i.dataset.action === "status" && /חזרה ל'נבדק'/.test(i.textContent ?? ""))!;
    expect(reopened).toHaveTextContent("לפני: אושר");
    expect(reopened).toHaveTextContent("אחרי: נבדק");
    expect(items.at(-1)).toHaveTextContent("חישוב מהשרטוטים");
    expect(items.at(-1)).toHaveTextContent("המערכת");
    expect(await axe(dlg)).toHaveNoViolations();
  });

  it("describeChange covers every action", () => {
    const t = i18n.t.bind(i18n);
    const base = { at: "2026-10-15T10:00:00Z", by: null, reason: null };
    expect(describeChange({ ...base, action: "status", before: { status: "draft" }, after: { status: "reviewed" } }, t)).toMatchObject({ before: "טיוטה", after: "נבדק" });
    expect(describeChange({ ...base, action: "qtyOverride", before: { qty: 5 }, after: { qty: 4, override: null } }, t).after).toContain("חזרה לכמות המחושבת");
    expect(describeChange({ ...base, action: "note", before: { note: null }, after: { note: "שימו לב" } }, t)).toMatchObject({ before: null, after: "שימו לב" });
    expect(describeChange({ ...base, action: "correction", before: null, after: { kind: "reclassify" } }, t).after).toBe("שיוך לסוג אחר");
    expect(describeChange({ ...base, action: "rebuild", before: null, after: { qty: 16 } }, t).after).toBe("16");
  });
});

describe("Export dialog: PDF מסומן (FR-29, E2E-13)", { timeout: 30_000 }, () => {
  function renderExport(backend: ReturnType<typeof createMockBackend>, lines: BoqLine[], rows: SheetRow[], opts: { canMarkedPdf?: boolean; blockOnRed?: boolean } = {}) {
    return wrap(
      backend,
      <ExportDialog projectId={PID} open onOpenChange={() => {}} lines={lines} templates={[]} blockOnRed={opts.blockOnRed ?? false} built onGoToItems={() => {}} sheets={rows} canMarkedPdf={opts.canMarkedPdf ?? true} pollMs={20} />,
    );
  }

  it("Excel stays the default and unchanged; PDF options → job progress → download via the signed URL", async () => {
    const user = userEvent.setup({ delay: null });
    const { backend, lines, rows } = await setup();
    const start = vi.spyOn(backend.api, "exportMarkedPdf");
    renderExport(backend, lines, rows);
    const dlg = screen.getByRole("dialog", { name: "ייצוא כתב כמויות לאקסל" });
    expect(within(dlg).getByRole("radio", { name: "אקסל" })).toHaveAttribute("aria-checked", "true");
    expect(within(dlg).getByLabelText("תבנית")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("radio", { name: "PDF מסומן" }));
    expect(screen.getByRole("dialog", { name: "ייצוא PDF מסומן" })).toHaveTextContent("קוד · תיאור · כמות · צבע");
    await user.click(within(dlg).getByLabelText("עמוד נפרד לכל קומה"));
    await user.click(within(dlg).getByLabelText("הסתר את טבלת הכותרת"));
    // subset of sheets
    await user.click(within(dlg).getByLabelText(`כל הגיליונות (${rows.length})`));
    const boxes = within(dlg).getAllByRole("checkbox").slice(3);
    expect(boxes).toHaveLength(rows.length);
    for (const b of boxes.slice(1)) await user.click(b);
    expect(within(dlg).getByText(`גיליונות · 1 מתוך ${rows.length} גיליונות`)).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "צור PDF" }));
    expect(start).toHaveBeenCalledWith(PID, { sheetIds: [rows[0]!.sheet.id], floorSplit: true, hideTitleBlock: true });
    const link = await within(dlg).findByRole("link", { name: "הורד PDF" }, WAIT);
    expect(link).toHaveAttribute("download", expect.stringMatching(/\.pdf$/));
    expect(link.getAttribute("href")).toMatch(/^(blob:|data:application\/pdf)/);
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    expect(within(dlg).getByText("ה-PDF מוכן (3 עמודים).")).toBeInTheDocument();
    expect(within(dlg).getByText("קישור ההורדה בתוקף 15 דקות.")).toBeInTheDocument();
    expect(await axe(dlg)).toHaveNoViolations();
  });

  it("no sheet selected → cannot submit; viewers / reviewers cannot export; org block applies", async () => {
    const user = userEvent.setup({ delay: null });
    const { backend, lines, rows } = await setup();
    const { unmount } = renderExport(backend, lines, rows);
    await user.click(screen.getByRole("radio", { name: "PDF מסומן" }));
    await user.click(screen.getByLabelText(`כל הגיליונות (${rows.length})`));
    for (const b of screen.getAllByRole("checkbox").slice(3)) await user.click(b);
    expect(screen.getByText("בחרו לפחות גיליון אחד.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "צור PDF" })).toBeDisabled();
    unmount();
    const r2 = renderExport(backend, lines, rows, { canMarkedPdf: false });
    await user.click(screen.getByRole("radio", { name: "PDF מסומן" }));
    expect(screen.getByText("רק עורכים ומנהלים יכולים לייצא PDF מסומן.")).toBeInTheDocument();
    r2.unmount();
    const red = lines.map((l, i) => (i === 0 ? { ...l, level: "red" as const, status: "draft" as const } : l));
    renderExport(backend, red, rows, { blockOnRed: true });
    await user.click(screen.getByRole("radio", { name: "PDF מסומן" }));
    expect(screen.getByText("לא ניתן לייצא עדיין.")).toBeInTheDocument();
  });
});
