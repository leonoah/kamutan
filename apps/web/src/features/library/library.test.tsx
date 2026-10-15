import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "@/test/axe";
import { makeFile, renderApp, type RenderAppOptions } from "@/test/utils";
import { useToastStore } from "@/components/ui/toast";

const toasts = () => useToastStore.getState().items.map((t) => t.title);

async function open(path = "/library", opts: RenderAppOptions = {}) {
  const utils = await renderApp(path, { signedIn: true, ...opts });
  await screen.findByRole("heading", { level: 1, name: /ספריית סעיפים/ });
  return utils;
}

describe("Library screen (/library)", { timeout: 30_000 }, () => {
  it("lists items with codes as LTR text, search and chapter filter; nav link is active", async () => {
    const user = userEvent.setup();
    const { container } = await open();
    expect(screen.getByRole("link", { name: "ספרייה" })).toHaveAttribute("aria-current", "page");
    const table = await screen.findByRole("table", { name: "ספריית סעיפים" });
    await waitFor(() => expect(within(table).getAllByRole("row").length).toBeGreaterThan(20));
    const row410 = within(table).getByText("נק' מאור בעלת שני מפסקים מחליפים").closest("tr")!;
    expect(row410.querySelector('bdi[dir="ltr"]')).toHaveTextContent("4.10");
    // TEXT codes, sorted segment-wise: 4.09 before 4.10
    const codes = [...table.querySelectorAll("tbody bdi")].map((b) => b.textContent);
    expect(codes.indexOf("4.09")).toBeLessThan(codes.indexOf("4.10"));

    await user.type(screen.getByLabelText("חיפוש לפי קוד או תיאור"), "שקע כפול");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(1 + 1));
    await user.clear(screen.getByLabelText("חיפוש לפי קוד או תיאור"));
    await user.selectOptions(screen.getByLabelText("פרק"), "08");
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2));
    expect(screen.getByRole("table")).toHaveTextContent("התקנת גופי התאורה בבית");
    await user.type(screen.getByLabelText("חיפוש לפי קוד או תיאור"), "zzz");
    expect(await screen.findByText("אין סעיפים שמתאימים לחיפוש.")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("edits an item's unit / active (code + description are its identity) and saves", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole("button", { name: "ערוך 4.01" }));
    const dlg = await screen.findByRole("dialog", { name: /עריכת סעיף/ });
    expect(within(dlg).getByText("שקע כפול")).toBeInTheDocument();
    expect(within(dlg).getByText(/התיאור והקוד מזהים את הסעיף/)).toBeInTheDocument();
    const unit = within(dlg).getByLabelText("יחידה");
    await user.clear(unit);
    await user.click(within(dlg).getByRole("button", { name: "שמור" }));
    expect(within(dlg).getByText("חובה למלא יחידה.")).toBeInTheDocument();
    await user.type(unit, "נק'");
    await user.click(within(dlg).getByRole("checkbox", { name: /פעיל/ }));
    await user.click(within(dlg).getByRole("button", { name: "שמור" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toasts()).toContain("הסעיף 4.01 נשמר.");
    const row = (await screen.findByText("שקע כפול")).closest("tr")!;
    expect(within(row).getByText("לא פעיל")).toBeInTheDocument();
    expect(within(row).getByText("נק'")).toBeInTheDocument();
  });

  it("imports a past BOQ: rejects non-Excel files, then upload → progress → summary with ambiguous codes", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { container } = await open();
    await user.click(await screen.findByRole("button", { name: "ייבוא אקסל" }));
    const dlg = await screen.findByRole("dialog", { name: "ייבוא כתב כמויות קודם" });
    const input = within(dlg).getByLabelText("בחירת קובץ", { selector: "input" });
    await user.upload(input, makeFile("plan.pdf", "%PDF-1.7"));
    expect(within(dlg).getByRole("alert")).toHaveTextContent("אפשר לייבא רק קבצי xls או xlsx.");
    await user.upload(input, makeFile("boq_2025.xlsx", "PK\u0003\u0004 data"));
    expect(await within(dlg).findByText("הייבוא הסתיים", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(within(dlg).getByText("נוספו 3 סעיפים לספרייה")).toBeInTheDocument();
    expect(within(dlg).getByText("2 סעיפים עודכנו")).toBeInTheDocument();
    expect(within(dlg).getByText(/לא נוצרה תבנית חדשה/)).toBeInTheDocument();
    expect(within(dlg).getByText(/קוד אחד עם כמה תיאורים/)).toBeInTheDocument();
    expect(await axe(container.ownerDocument.body)).toHaveNoViolations();
    await user.click(within(dlg).getByRole("button", { name: "סיום" }));
    expect(await screen.findByText("אספקה והתקנת לוח תקשורת ביחידת דיור")).toBeInTheDocument();
  });

  it("a failed import shows the reason", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(await screen.findByRole("button", { name: "ייבוא אקסל" }));
    const dlg = await screen.findByRole("dialog", { name: "ייבוא כתב כמויות קודם" });
    await user.upload(within(dlg).getByLabelText("בחירת קובץ", { selector: "input" }), makeFile("corrupt.xls", "ÐÏ data"));
    expect(await within(dlg).findByText(/הייבוא נכשל: לא נמצא גיליון כמויות בקובץ/, undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("templates: read-only list, admin sets the default", async () => {
    const user = userEvent.setup();
    const { container } = await open("/library?tab=templates");
    const def = await screen.findByRole("heading", { name: "תבנית ברירת מחדל (לפי כתב הכמויות לדוגמה)" });
    expect(within(def.closest("li")!).getByText("ברירת מחדל")).toBeInTheDocument();
    expect(def.closest("li")).toHaveTextContent("פרק 04 – עבודות חשמל");
    const other = screen.getByRole("heading", { name: /תבנית מקוצרת/ }).closest("li")!;
    await user.click(within(other).getByRole("button", { name: "קבע כברירת מחדל" }));
    await waitFor(() => expect(within(other).getByText("ברירת מחדל")).toBeInTheDocument());
    expect(toasts()).toContain('"תבנית מקוצרת (חשמל ותאורה בלבד)" היא עכשיו תבנית ברירת המחדל.');
    expect(await axe(container)).toHaveNoViolations();
  });

  it("rules: admins toggle a rule; others see them read-only", async () => {
    const user = userEvent.setup();
    const { container } = await open("/library?tab=rules");
    const sw = await screen.findByRole("switch", { name: "הפעלת הכלל שקע כפול" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("table")).toHaveTextContent("מפסק אחד ← שתי נקודות");
    await user.click(sw);
    await waitFor(() => expect(screen.getByRole("switch", { name: "הפעלת הכלל שקע כפול" })).toHaveAttribute("aria-checked", "false"));
    expect(toasts()).toContain("הכלל עודכן. כתבי כמויות קיימים יסומנו לבנייה מחדש.");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("rules are read-only for editors", async () => {
    await open("/library?tab=rules", { orgs: [{ id: "org-demo", name: "סטודיו", role: "editor" }] });
    expect(await screen.findByText("רק מנהל/ת ארגון יכול/ה להפעיל או לכבות כללים.")).toBeInTheDocument();
    expect(screen.getAllByRole("switch").every((s) => (s as HTMLButtonElement).disabled)).toBe(true);
  });
});
