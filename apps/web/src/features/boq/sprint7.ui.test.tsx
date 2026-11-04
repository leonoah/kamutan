import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DrawingViewerProps } from "@kamutan/viewer";
import { axe } from "@/test/axe";
import { PDF_BYTES, makeFile, renderApp, type RenderAppOptions } from "@/test/utils";
import { createMockAuth } from "@/features/auth/authService";
import { useToastStore } from "@/components/ui/toast";

const LAZY = { timeout: 25_000 };
beforeAll(async () => {
  await import("@/features/review/ReviewPage");
  await import("@/features/viewer/SheetViewer");
  await import("@/features/boq/BoqPreviewPage");
}, 60_000);
vi.mock("@kamutan/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kamutan/viewer")>();
  return { ...actual, DrawingViewer: (p: DrawingViewerProps) => <div role="application" aria-label={p.ariaLabel} dir="ltr" /> };
});
beforeEach(() => useToastStore.setState({ items: [] }));

const toasts = () => useToastStore.getState().items.map((t) => t.title);
const row = (code: string) => document.querySelector<HTMLTableRowElement>(`tr[data-code="${code}"]`)!;
const table = () => document.querySelector<HTMLTableElement>("[data-boq-table]")!;

async function openPreview(query = "", opts: RenderAppOptions = {}) {
  const utils = await renderApp(`/projects/p-noah/boq/preview${query}`, { signedIn: true, boqPrebuilt: true, devIndex: false, ...opts });
  await screen.findByRole("heading", { level: 1, name: "תצוגה מקדימה של כתב הכמויות" }, LAZY);
  await waitFor(() => expect(table()).toBeTruthy(), LAZY);
  await waitFor(() => expect(table().querySelector('tr[data-code="4.01"]')).toBeTruthy(), LAZY);
  return utils;
}

async function openReview(opts: RenderAppOptions = {}) {
  const utils = await renderApp("/projects/p-noah/review", { signedIn: true, boqPrebuilt: true, devIndex: false, ...opts });
  await screen.findByRole("application", { name: /^שרטוט/ }, LAZY);
  await waitFor(() => expect(row("4.01")).toBeTruthy(), LAZY);
  return utils;
}

describe("Sprint 7: BOQ preview (the Excel, rendered from BoqDocumentModel)", { timeout: 60_000 }, () => {
  it("title rows, the column set, chapters with numbered notes, subtotals, totals before / after VAT, warning banner; axe", async () => {
    const { container, api } = await openPreview();
    const doc = await api.getBoqDocument("p-noah", { split: "none", confidence: true, chapters: null });
    const titles = document.querySelector("[data-title-rows]")!;
    for (const r of doc.titleRows) expect(titles).toHaveTextContent(r.text);
    expect(titles.querySelector('[data-title-kind="warning"]')).toHaveTextContent("יש פריטים שלא נבדקו");
    expect(titles).toHaveTextContent("בית משפחת נח");
    expect(titles).toHaveTextContent("רחוב הדקל 12, רמת השרון");
    const t = table();
    const heads = within(t).getAllByRole("columnheader").filter((h) => h.getAttribute("scope") === "col").map((h) => h.textContent);
    expect(heads).toEqual(["סעיף", "תאור העבודה", "יחידה", 'כמות סה"כ', "מחיר יח'", 'סה"כ ₪', "רמת ביטחון", "סטטוס"]);
    // chapters + numbered notes (chapter 04 has 4 notes in the template)
    const ch04 = t.querySelector('tbody[data-chapter="04"]')!;
    expect(within(ch04 as HTMLElement).getByRole("columnheader", { name: /פרק 04/ })).toBeInTheDocument();
    expect(ch04).toHaveTextContent("הערות:");
    expect([...ch04.querySelectorAll("tr[data-note-row]")].map((r) => r.textContent)).toEqual(["הערות:", ...doc.chapters.find((c) => c.code === "04")!.notes.map((n, i) => `${i + 1}. ${n}`)]);
    expect(ch04.querySelectorAll("tr[data-note-row]")).toHaveLength(5);
    expect(t.querySelectorAll("tr[data-subtotal]")).toHaveLength(doc.chapters.length);
    const totals = t.querySelector("[data-grand-totals]")!;
    expect(totals).toHaveTextContent('סה"כ כללי לא כולל מע"מ');
    expect(totals).toHaveTextContent('מע"מ (18%)');
    expect(totals).toHaveTextContent('סה"כ כללי כולל מע"מ');
    // a line waiting for input: empty qty + the note
    const waiting = t.querySelector("tr[data-needs-input]")!;
    expect(waiting).toHaveTextContent("להשלמה ידנית");
    // banner (red / not approved / needs input, as in the export gate)
    const warn = document.querySelector("[data-preview-warning]")!;
    expect(warn).toHaveTextContent("יש שורות שעדיין לא מוכנות");
    expect(warn).toHaveTextContent(/שורות "לבדיקה"/);
    expect(warn).toHaveTextContent(/להשלמה ידנית/);
    expect(document.querySelector("[data-generated]")).toHaveTextContent(/הופק .* · \d+ שורות/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("options: split by floor, hide the confidence columns, choose chapters (kept in the URL)", async () => {
    const user = userEvent.setup({ delay: null });
    const { router, api } = await openPreview();
    await user.click(screen.getByRole("radio", { name: "מפורק לפי קומה" }));
    await waitFor(() => expect(router.state.location.search).toContain("split=floor"));
    const split = await api.getBoqDocument("p-noah", { split: "floor", confidence: true, chapters: null });
    const n = split.chapters.reduce((s, c) => s + c.rows.filter((r) => r.kind === "line").length, 0);
    await waitFor(() => expect(table().querySelectorAll("tr[data-row-line]")).toHaveLength(n));
    const perFloor = split.chapters.flatMap((c) => c.rows).find((r) => r.floor);
    if (perFloor) expect(table()).toHaveTextContent(perFloor.description);

    await user.click(screen.getByRole("checkbox", { name: 'הצג עמודות "רמת ביטחון" ו"סטטוס"' }));
    await waitFor(() => expect(within(table()).queryByRole("columnheader", { name: "רמת ביטחון" })).toBeNull());
    expect(router.state.location.search).toContain("confidence=0");

    // chapters: untick "all" → nothing chosen; tick 04 only
    fireEvent.click(screen.getByText(/פרקים:/));
    await user.click(screen.getByRole("checkbox", { name: "כל הפרקים" }));
    expect(await screen.findByText("בחרו לפחות פרק אחד.")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /פרק 04/ }));
    await waitFor(() => expect(table().querySelectorAll("tbody[data-chapter]")).toHaveLength(1));
    expect(table().querySelector('tbody[data-chapter="04"]')).toBeTruthy();
    expect(router.state.location.search).toContain("chapters=04");
  });

  it("a row opens the line in the review workspace; 'ייצוא לאקסל' opens the export dialog with the same split", async () => {
    const user = userEvent.setup({ delay: null });
    const { router } = await openPreview("?split=floor");
    await user.click(screen.getByRole("button", { name: "ייצוא לאקסל" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByRole("radio", { name: "מפורק לפי קומה" })).toBeChecked();
    expect(within(dlg).queryByText("תצוגה מקדימה")).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const r = table().querySelector<HTMLElement>('tr[data-code="4.01"]')!;
    const lineId = r.getAttribute("data-row-line")!;
    fireEvent.click(r.querySelectorAll("td")[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/p-noah/review"));
    expect(router.state.location.search).toBe(`?line=${encodeURIComponent(lineId)}`);
  });

  it("is linked from the hub card, the BOQ panel and the export dialog", async () => {
    const user = userEvent.setup({ delay: null });
    await renderApp("/projects/p-noah", { signedIn: true, boqPrebuilt: true, devIndex: false });
    const hubLink = await screen.findByRole("link", { name: "תצוגה מקדימה של כתב הכמויות" }, LAZY);
    expect(hubLink).toHaveAttribute("href", "/projects/p-noah/boq/preview");
    await openReview();
    const panelLink = document.querySelector("#boq-panel [data-preview-link]")!;
    expect(panelLink).toHaveAttribute("href", "/projects/p-noah/boq/preview");
    await user.click(screen.getByRole("button", { name: "ייצוא", exact: true } as never));
    const dlg = await screen.findByRole("dialog");
    await user.click(within(dlg).getByText("מפורק לפי קומה"));
    expect(within(dlg).getByRole("link", { name: "תצוגה מקדימה" })).toHaveAttribute("href", "/projects/p-noah/boq/preview?split=floor");
  });
});

describe("Sprint 7: rename a line (descriptionOverride)", { timeout: 60_000 }, () => {
  it("double-click → edit in place (counter, Esc cancels) → Enter saves: marker, toast with undo, history before → after", async () => {
    const user = userEvent.setup({ delay: null });
    const { api, container } = await openReview();
    const textBtn = row("4.01").querySelector<HTMLButtonElement>("[data-description-for] button")!;
    const original = textBtn.textContent!;
    // Esc cancels
    await user.dblClick(textBtn);
    let box = await screen.findByRole("textbox", { name: "תאור העבודה של סעיף 4.01" });
    await user.type(box, " זמני");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "תאור העבודה של סעיף 4.01" })).toBeNull();
    expect(row("4.01")).toHaveTextContent(original);
    // Enter on the (focused) text button opens it too
    row("4.01").querySelector<HTMLButtonElement>("[data-description-for] button")!.focus();
    await user.keyboard("{Enter}");
    box = await screen.findByRole("textbox", { name: "תאור העבודה של סעיף 4.01" });
    expect(box).toHaveAttribute("maxlength", "500");
    await user.clear(box);
    await user.type(box, "שקע כפול לבן מוגן מים");
    expect(document.querySelector("[data-rename-counter]")).toHaveTextContent("21/500");
    await user.type(screen.getByLabelText("סיבה (לא חובה)"), "לפי בקשת הלקוח");
    expect(await axe(container)).toHaveNoViolations();
    await user.type(box, "{Enter}");
    await waitFor(() => expect(row("4.01")).toHaveTextContent("שקע כפול לבן מוגן מים"));
    expect(row("4.01").querySelector("[data-manual-name]")).toHaveTextContent("✎ ידני");
    expect(row("4.01").querySelector("[data-manual-name]")).toHaveAttribute("title", expect.stringContaining(original));
    await waitFor(() => expect(toasts()).toContain("השם של סעיף 4.01 עודכן."));
    const l = (await api.listBoqLines("p-noah")).items.find((x) => x.code === "4.01")!;
    expect(l).toMatchObject({ descriptionOverride: "שקע כפול לבן מוגן מים", descriptionOverrideReason: "לפי בקשת הלקוח", description: original });
    // history: before → after + reason
    await user.click(row("4.01").querySelector<HTMLButtonElement>("[data-history-for]")!);
    const dlg = await screen.findByRole("dialog");
    const item = await within(dlg).findByText("שינוי שם השורה");
    const li = item.closest("li")!;
    expect(li).toHaveTextContent(original);
    expect(li).toHaveTextContent("שקע כפול לבן מוגן מים");
    expect(li).toHaveTextContent("לפי בקשת הלקוח");
  });

  it("restore → the original wording, marker gone; undo from the toast brings the rename back", async () => {
    const user = userEvent.setup({ delay: null });
    const { api } = await openReview();
    const id = row("4.02").getAttribute("data-line")!;
    await user.click(screen.getByRole("button", { name: "שינוי שם של סעיף 4.02" }));
    const box = await screen.findByRole("textbox", { name: "תאור העבודה של סעיף 4.02" });
    await user.clear(box);
    await user.type(box, "אביזר שלישיית שקעים לבן{Enter}");
    await waitFor(() => expect(row("4.02")).toHaveTextContent("אביזר שלישיית שקעים לבן"), LAZY);
    await user.click(screen.getByRole("button", { name: "שינוי שם של סעיף 4.02" }));
    expect(screen.getByText(/נוסח מקורי:/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "שחזר לנוסח המקורי" }));
    await waitFor(() => expect(row("4.02").querySelector("[data-manual-name]")).toBeNull());
    await waitFor(() => expect(toasts()).toContain("סעיף 4.02 חזר לנוסח המקורי."));
    expect((await api.listBoqLines("p-noah")).items.find((x) => x.id === id)!.descriptionOverride ?? null).toBeNull();
    // undo
    useToastStore.getState().items.find((x) => x.title === "סעיף 4.02 חזר לנוסח המקורי.")!.action!.onClick();
    await waitFor(() => expect(row("4.02")).toHaveTextContent("אביזר שלישיית שקעים לבן"));
  });

  it("a rename survives a rebuild", async () => {
    const { api } = await openReview();
    const id = row("4.01").getAttribute("data-line")!;
    await api.patchBoqLine("p-noah", id, { description: "שם ידני" });
    await api.buildBoq("p-noah");
    await waitFor(async () => expect((await api.listBoqLines("p-noah")).boq?.stale).toBe(false), LAZY);
    await waitFor(async () => expect((await api.listBoqLines("p-noah")).items.find((x) => x.id === id)?.descriptionOverride).toBe("שם ידני"), LAZY);
  });

  it("'עדכן גם בספריית הסעיפים' with an old sign-in → re-authentication box → saved in the line and the library", async () => {
    const user = userEvent.setup({ delay: null });
    const auth = createMockAuth({ persist: false, latencyMs: 0, authAgeMs: 30 * 60_000 });
    const { api } = await openReview({ auth });
    await user.click(screen.getByRole("button", { name: "שינוי שם של סעיף 4.01" }));
    const box = await screen.findByRole("textbox", { name: "תאור העבודה של סעיף 4.01" });
    await user.clear(box);
    await user.type(box, "שקע כפול (מעודכן)");
    await user.click(screen.getByRole("checkbox", { name: "עדכן גם בספריית הסעיפים" }));
    await user.click(screen.getByRole("button", { name: "שמור" }));
    const reauth = await screen.findByRole("alertdialog");
    expect(reauth).toHaveAttribute("data-reauth");
    // nothing changed yet (refused as a whole)
    expect((await api.listBoqLines("p-noah")).items.find((x) => x.code === "4.01")!.descriptionOverride ?? null).toBeNull();
    await user.type(within(reauth).getByLabelText("סיסמה"), "correct-horse-battery");
    await user.click(within(reauth).getByRole("button", { name: "אמת" }));
    await waitFor(() => expect(toasts()).toContain("השם של סעיף 4.01 עודכן, גם בספריית הסעיפים."));
    const item = (await api.listLibraryItems("org-demo", { q: "4.01" })).items.find((i) => i.code === "4.01")!;
    expect(item).toMatchObject({ description: "שקע כפול (מעודכן)", source: "manual" });
  });

  it("editors rename on the hub card (pencil); reviewers / viewers get no pencil; the hub shows the storage use", async () => {
    const user = userEvent.setup({ delay: null });
    const { api } = await renderApp("/projects/p-noah", { signedIn: true, boqPrebuilt: true, devIndex: false, orgs: [{ id: "org-demo", name: "סטודיו", role: "editor" }] });
    await waitFor(() => expect(document.querySelector('tr[data-code="4.01"]')).toBeTruthy(), LAZY);
    expect(document.querySelector("[data-storage]")).toHaveTextContent(/אחסון: .*46\.3 MB.* מתוך .*2 GB/);
    expect(screen.getByRole("meter", { name: "שימוש באחסון הפרויקט" })).toHaveAttribute("aria-valuenow", "2");
    await user.click(screen.getByRole("button", { name: "שינוי שם של סעיף 4.01" }));
    const box = await screen.findByRole("textbox", { name: "תאור העבודה של סעיף 4.01" });
    await user.clear(box);
    await user.type(box, "שקע כפול בהזמנה{Enter}");
    await waitFor(() => expect(document.querySelector('tr[data-code="4.01"]')).toHaveTextContent("שקע כפול בהזמנה"));
    expect(document.querySelector('tr[data-code="4.01"] [data-manual-name]')).toBeTruthy();
    expect((await api.listBoqLines("p-noah")).items.find((x) => x.code === "4.01")!.descriptionOverride).toBe("שקע כפול בהזמנה");
  });

  it("reviewers cannot rename (no pencil, Enter selects)", async () => {
    await openReview({ orgs: [{ id: "org-demo", name: "סטודיו", role: "reviewer" }] });
    expect(screen.queryByRole("button", { name: "שינוי שם של סעיף 4.01" })).toBeNull();
    const btn = row("4.01").querySelector<HTMLButtonElement>("[data-description-for] button")!;
    fireEvent.doubleClick(btn);
    expect(screen.queryByRole("textbox", { name: /תאור העבודה של סעיף/ })).toBeNull();
  });

  it("the preview and the share snapshot show the renamed wording with the marker", async () => {
    const user = userEvent.setup({ delay: null });
    const { api, backend } = await openPreview();
    const id = table().querySelector('tr[data-code="4.01"]')!.getAttribute("data-row-line")!;
    await api.patchBoqLine("p-noah", id, { description: "שקע כפול לבן" });
    // another option → a fresh document from the API
    await user.click(screen.getByRole("radio", { name: "מפורק לפי קומה" }));
    await waitFor(() => expect(table().querySelector('tr[data-code="4.01"]')).toHaveTextContent("שקע כפול לבן"), LAZY);
    expect(table().querySelector('tr[data-code="4.01"] [data-manual-name]')).toBeTruthy();
    const link = await api.createShareLink("p-noah", { days: 7, label: "לקוח" });
    const token = link.url.split("/s/")[1]!;
    const boq = await backend.publicShare.getBoq(token);
    expect(boq.lines.find((l) => l.code === "4.01")).toMatchObject({ description: "שקע כפול לבן", descriptionManual: true });
  });
});

describe("Sprint 7: upload hardening (quota, infected files)", { timeout: 60_000 }, () => {
  const openLevi = async (opts: RenderAppOptions = {}) => {
    const r = await renderApp("/projects/p-levi", { signedIn: true, ...opts });
    await screen.findByRole("heading", { level: 1, name: /דירת לוי/ });
    await waitFor(() => expect(screen.queryByTestId("file-input") ?? screen.queryByRole("button", { name: "העלאת שרטוטים" })).toBeTruthy());
    if (!screen.queryByTestId("file-input")) {
      fireEvent.click(screen.getByRole("button", { name: "העלאת שרטוטים" }));
      await screen.findByTestId("file-input");
    }
    return r;
  };
  const fileRow = (name: string) => within(screen.getByRole("list", { name: "קבצים בהעלאה" })).getByText(name).closest("li") as HTMLElement;

  it("413 quota_exceeded → the Hebrew message on the file; nothing is stored", async () => {
    const user = userEvent.setup();
    const { container } = await openLevi({ projectQuotaBytes: 8 });
    await user.upload(screen.getByTestId("file-input"), [makeFile("גדול.pdf", PDF_BYTES)]);
    await waitFor(() => expect(within(fileRow("גדול.pdf")).getByRole("alert")).toHaveTextContent(/אין מספיק מקום בפרויקט/));
    expect(within(fileRow("גדול.pdf")).getByText("נכשל")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("an infected file (worker: file_infected) → 'הקובץ נחסם: זוהה תוכן זדוני' on that file only", async () => {
    const user = userEvent.setup();
    const { container } = await openLevi();
    await user.upload(screen.getByTestId("file-input"), [makeFile("eicar.pdf", PDF_BYTES), makeFile("נקי.pdf", PDF_BYTES + "x")]);
    await waitFor(() => expect(fileRow("eicar.pdf").querySelector("[data-file-infected]")).toBeTruthy(), { timeout: 5000 });
    expect(fileRow("eicar.pdf")).toHaveTextContent("הקובץ נחסם: זוהה תוכן זדוני");
    expect(fileRow("נקי.pdf").querySelector("[data-file-infected]")).toBeNull();
    // the processing list explains it too
    await waitFor(() => expect(screen.getAllByText(/הקובץ נחסם: זוהה תוכן זדוני/).length).toBeGreaterThan(1));
    expect(await axe(container)).toHaveNoViolations();
  });
});
