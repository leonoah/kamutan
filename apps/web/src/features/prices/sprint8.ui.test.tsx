import { COMPARE_NO_PREVIOUS_HE } from "@kamutan/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";
import { useToastStore } from "@/components/ui/toast";

const toasts = () => useToastStore.getState().items.map((t) => t.title);
const fast = { signedIn: true, devIndex: false, boqTickMs: 1, jobTickMs: 1 } as const;

describe("Sprint 8 UI", { timeout: 40_000 }, () => {
  beforeAll(async () => {
    // lazy route chunks (first import is slow under a parallel run)
    await Promise.all([
      import("@/features/library/LibraryPage"),
      import("@/features/compare/ComparePage"),
      import("@/features/projects/ProjectSettingsPage"),
      import("@/features/projects/ProjectPage"),
      import("@/features/projects/ProjectsPage"),
    ]);
  });

  it("library: price column, inline edit (Enter saves, ✎ ידני), bulk +10%; axe", async () => {
    const user = userEvent.setup();
    const { container } = await renderApp("/library", fast);
    const table = await screen.findByRole("table", { name: "ספריית סעיפים" }, { timeout: 20_000 });
    await waitFor(() => expect(table.querySelector('tr[data-item="4.01"] [data-item-price]')).toHaveTextContent("₪"));
    expect(await axe(container)).toHaveNoViolations();
    const cell = () => table.querySelector('tr[data-item="4.02"] [data-item-price]') as HTMLElement;
    await user.click(cell());
    const input = screen.getByLabelText("מחיר של סעיף 4.02");
    await user.clear(input);
    await user.type(input, "200{Enter}");
    await waitFor(() => expect(cell()).toHaveTextContent("₪ 200.00"));
    expect(cell()).toHaveTextContent("ידני");
    expect(toasts()).toContain("המחיר של סעיף 4.02 נשמר");

    await user.click(screen.getByRole("checkbox", { name: "בחירת סעיף 4.02" }));
    await user.click(within(screen.getByRole("region", { name: "עריכת מחירים לכמה סעיפים" })).getByRole("button", { name: "עריכת מחירים" }));
    const dlg = await screen.findByRole("dialog");
    await user.click(within(dlg).getByRole("radio", { name: "שינוי באחוזים" }));
    await user.type(within(dlg).getByLabelText("אחוז שינוי (שלילי = הוזלה)"), "10");
    expect(within(dlg).getByText("ישתנה סעיף אחד")).toBeInTheDocument();
    expect(await axe(dlg)).toHaveNoViolations();
    await user.click(within(dlg).getByRole("button", { name: "החלה" }));
    await waitFor(() => expect(cell()).toHaveTextContent("₪ 220.00"));
  });

  it("compare: summary, removed 4.99, causes link to the sheet; no previous build → explanation; axe", async () => {
    const { container } = await renderApp("/projects/p-noah/boq/compare", { ...fast, boqPrebuilt: true });
    const table = await screen.findByRole("table", { name: "שורות שהשתנו בין שתי הגרסאות" }, { timeout: 20_000 });
    expect(table.querySelector('tr[data-compare-line="4.99"]')).toHaveAttribute("data-change", "removed");
    expect(table.querySelector("[data-cause-link]")).toBeTruthy();
    expect(screen.getByText(/שינוי בסה"כ/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("compare before any build: the API's 409 not_ready text", async () => {
    await renderApp("/projects/p-noah/boq/compare", fast);
    expect(await screen.findByText(COMPARE_NO_PREVIOUS_HE, {}, { timeout: 20_000 })).toHaveAttribute("data-compare-empty", "not_ready");
  });

  it("project settings: discount saved; delete project needs the exact name + checkbox → back to the list; axe", async () => {
    const user = userEvent.setup();
    const { container, router } = await renderApp("/projects/p-levi/settings", { ...fast, auth: undefined });
    await screen.findByRole("heading", { level: 1, name: "הגדרות הפרויקט" }, { timeout: 20_000 });
    await user.type(screen.getByLabelText("אחוז (מספר שלילי = הנחה)"), "-7.5");
    await user.click(screen.getByRole("button", { name: "שמירה" }));
    expect(await screen.findByText("הנחה 7.5%")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "מחיקת הפרויקט" }));
    const dlg = await screen.findByRole("alertdialog");
    const confirm = within(dlg).getByRole("button", { name: "מחיקת הפרויקט לצמיתות" });
    await user.type(within(dlg).getByRole("textbox"), "דירת לוי — שיפוץ מטבח ורחצה");
    expect(confirm).toBeDisabled();
    await user.click(within(dlg).getByRole("checkbox", { name: "הבנתי שאי אפשר לשחזר את הפרויקט" }));
    expect(await axe(dlg)).toHaveNoViolations();
    await user.click(confirm);
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
    expect(toasts().some((x) => /נמחק\. פונו/.test(x))).toBe(true);
  });

  it("hub: delete a sheet set from the upload history → toast with the storage; sheet limit banner", async () => {
    const user = userEvent.setup();
    await renderApp("/projects/p-noah", { ...fast, sheetLimit: 2 });
    expect(await screen.findByText(/הגעתם למגבלה של 2 גיליונות בפרויקט/, {}, { timeout: 20_000 })).toBeInTheDocument();
    await user.click(await screen.findByText("העלאות ועיבוד", {}, { timeout: 20_000 }));
    const del = await waitFor(() => {
      const b = document.querySelector("[data-set-status] [data-delete-set]") as HTMLElement | null;
      expect(b).toBeTruthy();
      return b!;
    });
    await user.click(del);
    const dlg = await screen.findByRole("alertdialog");
    expect(await axe(dlg)).toHaveNoViolations();
    await user.click(within(dlg).getByRole("button", { name: "מחיקה לצמיתות" }));
    await waitFor(() => expect(toasts().some((x) => /נמחק\. פונו .* אחסון:/.test(x))).toBe(true));
  });

  it("viewer role: no inline price edit, no bulk selection", async () => {
    await renderApp("/library", { ...fast, orgs: [{ id: "org-demo", name: "סטודיו", role: "viewer" }] });
    const table = await screen.findByRole("table", { name: "ספריית סעיפים" }, { timeout: 20_000 });
    await waitFor(() => expect(table.querySelector('tr[data-item="4.01"] [data-item-price]')).toBeTruthy());
    expect(table.querySelector('tr[data-item="4.01"] button[data-item-price]')).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "בחירת סעיף 4.01" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ייבוא מחירים" })).toBeNull();
  });
});
