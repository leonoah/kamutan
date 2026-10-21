import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";
import { createMockAuth } from "@/features/auth/authService";
import { useToastStore } from "@/components/ui/toast";

const WAIT = { timeout: 15_000 };
const toasts = () => useToastStore.getState().items.map((t) => t.title);
beforeAll(async () => {
  await import("./SettingsLayout");
  await import("./OrgSettingsPage");
  await import("./AuditLogPage");
  await import("./OffboardingPage");
}, 60_000);

describe("Org settings (S14, FR-31) — admin only", { timeout: 30_000 }, () => {
  it("non-admins get no nav link and a calm 'admins only' screen", async () => {
    await renderApp("/settings", { signedIn: true, orgs: [{ id: "org-demo", name: "סטודיו", role: "editor" }] });
    expect(await screen.findByText("רק מנהלי ארגון יכולים לראות ולשנות את ההגדרות.", {}, WAIT)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "הגדרות" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("admin: threshold + 3 switches; save sends only the changes, audited; reset", async () => {
    const user = userEvent.setup({ delay: null });
    const { backend } = await renderApp("/settings", { signedIn: true });
    const patch = vi.spyOn(backend.api, "patchOrgSettings");
    expect(await screen.findByRole("link", { name: "הגדרות" }, WAIT)).toBeInTheDocument();
    const slider = await screen.findByLabelText("סף 'מאומת'", {}, WAIT);
    expect(slider).toHaveAttribute("min", "0.9");
    expect(slider).toHaveAttribute("max", "0.995");
    expect(slider).toHaveValue("0.98");
    const block = screen.getByRole("switch", { name: "חסום ייצוא כשיש שורות 'לבדיקה'" });
    const llm = screen.getByRole("switch", { name: "שימוש במודל שפה חיצוני (LLM)" });
    const train = screen.getByRole("switch", { name: "הסכמה לשימוש בתיקונים לשיפור הזיהוי" });
    expect([block, llm, train].map((s) => s.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect(screen.getByRole("button", { name: "שמור שינויים" })).toBeDisabled();

    await user.click(llm);
    expect(llm).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("יש שינויים שלא נשמרו")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "בטל שינויים" }));
    expect(llm).toHaveAttribute("aria-checked", "false");

    await user.click(block);
    await user.click(train);
    await user.click(screen.getByRole("button", { name: "שמור שינויים" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("org-demo", { blockExportOnRed: true, trainingOptIn: true }));
    await waitFor(() => expect(toasts()).toContain("ההגדרות נשמרו ונרשמו ביומן."));
    await waitFor(() => expect(screen.getByRole("button", { name: "שמור שינויים" })).toBeDisabled());
    expect((await backend.api.listAudit("org-demo", { action: "update_settings" })).items).toHaveLength(2);
    expect(await axe(document.querySelector("main")!)).toHaveNoViolations();
  });
});

describe("Audit log (S13, SEC-35)", { timeout: 30_000 }, () => {
  it("newest first, paging, filters, chain-verify indicator", async () => {
    const user = userEvent.setup({ delay: null });
    await renderApp("/settings/audit", { signedIn: true });
    await waitFor(() => expect(document.querySelectorAll("[data-audit-row]").length).toBe(20), WAIT);
    expect(await screen.findByText(/^שרשרת היומן תקינה · \d+ רשומות נבדקו$/, {}, WAIT)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "טען עוד" }));
    await waitFor(() => expect(document.querySelectorAll("[data-audit-row]").length).toBe(40));
    await user.click(screen.getByRole("button", { name: "טען עוד" }));
    await waitFor(() => expect(document.querySelectorAll("[data-audit-row]").length).toBe(42));
    expect(screen.queryByRole("button", { name: "טען עוד" })).toBeNull();

    await user.selectOptions(screen.getByLabelText("פעולה"), "login");
    await waitFor(() => expect(document.querySelectorAll('[data-audit-row]:not([data-audit-row="login"])').length).toBe(0));
    expect(document.querySelectorAll('[data-audit-row="login"]').length).toBeGreaterThan(0);
    expect(screen.getAllByText("כניסה למערכת").length).toBeGreaterThan(0);
    await user.selectOptions(screen.getByLabelText("פעולה"), "");
    await user.selectOptions(screen.getByLabelText("על מה"), "members");
    await waitFor(() => expect([...document.querySelectorAll("[data-audit-row]")].every((r) => /^(create|update)$/.test(r.getAttribute("data-audit-row")!))).toBe(true));
    expect(await axe(document.querySelector("[data-audit]")!)).toHaveNoViolations();
  });

  it("a broken hash chain is flagged", async () => {
    await renderApp("/settings/audit", { signedIn: true, auditBroken: true });
    expect(await screen.findByText(/נמצא שבר בשרשרת היומן/, {}, WAIT)).toBeInTheDocument();
    expect(document.querySelector('[data-verify="broken"]')).toBeTruthy();
  });
});

describe("Offboarding (SEC-52)", { timeout: 40_000 }, () => {
  it("export ZIP → warnings → typed org name + acknowledgement → offboard; org then blocked", async () => {
    const user = userEvent.setup({ delay: null });
    const { backend } = await renderApp("/settings/offboarding", { signedIn: true });
    const off = vi.spyOn(backend.api, "offboardOrg");
    await user.click(await screen.findByRole("button", { name: "הכן ייצוא מלא" }, WAIT));
    const dl = await screen.findByRole("link", { name: "הורד ZIP" }, WAIT);
    expect(dl).toHaveAttribute("download", "kamutan-export.zip");
    expect(screen.getByText(/ההורדה זמינה עד/)).toBeInTheDocument();
    for (const w of ["כל המשתמשים בארגון ינותקו מיד", "בעוד 30 יום כל הנתונים יימחקו לצמיתות", "תעודת מחיקה"]) expect(screen.getByText(new RegExp(w))).toBeInTheDocument();
    expect(screen.getByText(/עוד לא הורדתם ייצוא מלא/)).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "סיים התקשרות ומחק את הנתונים" });
    expect(submit).toBeDisabled();
    const input = screen.getByLabelText(/כדי לאשר, הקלידו את שם הארגון/);
    await user.type(input, "סטודיו");
    expect(screen.getByText("השם לא תואם.")).toBeInTheDocument();
    await user.type(input, " נח לעיצוב פנים");
    await user.click(screen.getByLabelText(/הבנתי שהפעולה סופית/));
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(off).toHaveBeenCalledWith("org-demo", { confirm: "סטודיו נח לעיצוב פנים" }));
    expect(await screen.findByText(/הארגון בתהליך סיום התקשרות\. הנתונים יימחקו ב-\d\d\.\d\d\.\d{4}\./, {}, WAIT)).toBeInTheDocument();
  });

  it("an old sign-in (auth_time > 10 min) must re-authenticate first; wrong password refused", async () => {
    const user = userEvent.setup({ delay: null });
    const auth = createMockAuth({ persist: false, latencyMs: 0, authAgeMs: 60 * 60_000 });
    const { backend } = await renderApp("/settings/offboarding", { signedIn: true, auth });
    const off = vi.spyOn(backend.api, "offboardOrg");
    await user.type(await screen.findByLabelText(/כדי לאשר, הקלידו את שם הארגון/, {}, WAIT), "סטודיו נח לעיצוב פנים");
    await user.click(screen.getByLabelText(/הבנתי שהפעולה סופית/));
    await user.click(screen.getByRole("button", { name: "סיים התקשרות ומחק את הנתונים" }));
    const box = await screen.findByRole("alertdialog", { name: "נדרשת כניסה מחדש" });
    expect(off).not.toHaveBeenCalled();
    await user.type(within(box).getByLabelText("סיסמה"), "short");
    await user.click(within(box).getByRole("button", { name: "אמת" }));
    expect(await within(box).findByText("האימות נכשל. בדקו את הסיסמה ונסו שוב.")).toBeInTheDocument();
    const pw = within(box).getByLabelText("סיסמה");
    await user.clear(pw);
    await user.type(pw, "correct-horse-battery");
    await user.click(within(box).getByRole("button", { name: "אמת" }));
    await waitFor(() => expect(off).toHaveBeenCalledTimes(1), WAIT);
    expect(await screen.findByText(/הארגון בתהליך סיום התקשרות\./, {}, WAIT)).toBeInTheDocument();
  });

  it("an offboarding org blocks the app except the admin's export page", async () => {
    const { router } = await renderApp("/projects", { signedIn: true, onBackend: (b) => void b.api.offboardOrg("org-demo", { confirm: "סטודיו נח לעיצוב פנים" }) });
    expect(await screen.findByText("הארגון בתהליך סיום התקשרות", {}, WAIT)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "פרויקטים" })).toBeNull();
    expect(screen.getByRole("link", { name: "הורד ZIP" })).toHaveAttribute("href", "/settings/offboarding");
    await router.navigate("/settings/offboarding");
    expect(await screen.findByRole("button", { name: "הכן ייצוא מלא" }, WAIT)).toBeInTheDocument();
    expect(screen.getByText(/הארגון בתהליך סיום התקשרות\. הנתונים יימחקו ב-/)).toBeInTheDocument();
  });

  it("non-admin members of an offboarding org only see the blocked screen", async () => {
    await renderApp("/settings/offboarding", { signedIn: true, orgs: [{ id: "org-demo", name: "סטודיו", role: "editor" }], onBackend: (b) => {
      const getMe = b.api.getMe;
      b.api.getMe = async () => {
        const me = await getMe();
        return { ...me, orgs: me.orgs.map((o) => ({ ...o, status: "offboarding" as const, deleteAfter: "2026-11-14T00:00:00.000Z" })) };
      };
    } });
    expect(await screen.findByText("הארגון בתהליך סיום התקשרות", {}, WAIT)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "הורד ZIP" })).toBeNull();
  });
});
