/**
 * Stage 10 fix round (web): regression tests for the A-UI defects and the new flows (members, MFA/reauth, revised
 * upload, library state, approval invalidated by a quantity change).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";
import { createMockBackend } from "@/api/mock";
import { createMockAuth, setAuthService } from "@/features/auth/authService";
import { ApiError, isQtyChangedReason, needsReapproval, qtyChangedReason, qtyChangedSinceApproval } from "@/api/types";
import { chapterLabel, filterLines } from "@/features/boq/model";
import { uncertainFields } from "@/features/sheets/model";
import { auditSummary } from "@/features/settings/AuditLogPage";
import { EMPTY_FILTERS } from "@/features/understanding/model";
import { librarySourceOf } from "@/features/boq/LibraryNotice";
import { forwardEscapeToDialog, useToastStore } from "@/components/ui/toast";
import { ReasonChip } from "@/components/ReasonChip";

const WAIT = { timeout: 15_000 };
const PID = "p-noah";
const ORG = "org-demo";
const toasts = () => useToastStore.getState().items.map((t) => t.title);

async function built(opts: Parameters<typeof createMockBackend>[0] = {}) {
  const b = createMockBackend({ latencyMs: 0, jobTickMs: 5, uploadTickMs: 5, devIndex: false, boqPrebuilt: true, ...opts });
  for (let i = 0; i < 200 && (await b.api.listBoqLines(PID)).items.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  return b;
}
const until = async <T,>(fn: () => Promise<T>, ok: (v: T) => boolean) => {
  for (let i = 0; i < 400; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
};

describe("A-UI-18 chapter labels", () => {
  it("does not repeat the code and normalises the dash", () => {
    expect(chapterLabel("03", "פרק 03 – עבודות אינסטלציה")).toBe("פרק 03 – עבודות אינסטלציה");
    expect(chapterLabel("08", "פרק 08 - שונות")).toBe("פרק 08 – שונות");
    expect(chapterLabel("04", "04 - עבודות חשמל")).toBe("פרק 04 – עבודות חשמל");
    expect(chapterLabel("05", "ריצוף וחיפוי")).toBe("פרק 05 – ריצוף וחיפוי");
    expect(chapterLabel("09", "")).toBe("פרק 09");
    expect(chapterLabel("1", "פרק 10 – x")).toBe("פרק 10 – x"); // a title naming another code keeps its own prefix
  });
});

describe("A-UI-19 floors that contradict the title", () => {
  it("FLOOR_TITLE_MISMATCH (or any FLOOR_* flag) makes the floors uncertain", () => {
    const row = (reasons: string[]) =>
      ({ sheet: { id: "s", sheetSetId: "x", currentVersionId: "v", floors: ["basement", "1"], classification: { discipline: "electrical", floors: ["basement", "1"], sheetTitle: "t", scaleText: "1:50", confidence: 0.9, level: "green", reasons } }, version: null }) as never;
    expect(uncertainFields(row(["FLOOR_TITLE_MISMATCH"])).has("floors")).toBe(true);
    expect(uncertainFields(row([])).has("floors")).toBe(false);
  });
});

describe("A-UI-13 audit details in plain Hebrew", () => {
  it("API summary wins; corrections / roles / statuses / settings are rendered; unknown stays raw", async () => {
    const i18n = (await import("@/i18n")).default;
    const t = i18n.t.bind(i18n);
    const ev = (x: Record<string, unknown>) => ({ id: "a", at: "2026-11-01T10:00:00Z", actor: null, action: "create", entity: "corrections", entityId: null, ...x }) as never;
    expect(auditSummary(ev({ summary: "סיכום מהשרת" }), t)).toBe("סיכום מהשרת");
    expect(auditSummary(ev({ after: { kind: "add", class: "socket_double" } }), t)).toBe("הוספת פריט ידני · שקע כפול");
    expect(auditSummary(ev({ entity: "members", action: "update", before: { role: "editor" }, after: { role: "viewer" } }), t)).toBe("עורך ← צופה");
    expect(auditSummary(ev({ entity: "boqLines", action: "approval_invalidated", before: { status: "approved" }, after: { status: "reviewed" }, meta: { reason: qtyChangedReason(15, 16) } }), t)).toBe(`אושר ← נבדק · ${qtyChangedReason(15, 16)}`);
    expect(auditSummary(ev({ entity: "orgs", action: "update_settings", before: { llmEnabled: false }, after: { llmEnabled: true } }), t)).toBe("שימוש במודל שפה חיצוני (LLM): כבוי ← פעיל");
    expect(auditSummary(ev({ entity: "shareLinks", action: "view", after: { ip: "1.2.3" } }), t)).toBeNull();
  });
});

describe("A-UI-23 Escape with a toast open", () => {
  it("forwards to the top-most open dialog's close button", () => {
    document.body.innerHTML = `<div role="dialog" data-state="open"><button data-dialog-close>x</button></div><div role="dialog" data-state="open"><button data-dialog-close id="top">x</button></div>`;
    const clicks: string[] = [];
    document.querySelectorAll("button").forEach((b, i) => b.addEventListener("click", () => clicks.push(String(i))));
    forwardEscapeToDialog();
    expect(clicks).toEqual(["1"]);
    document.body.innerHTML = "";
    expect(() => forwardEscapeToDialog()).not.toThrow();
  });
});

describe("Stage 10: approval invalidated by a quantity change (A-API-06 decision)", () => {
  const base = { status: "approved" as const, qty: 7 };
  it("needsReapproval / qtyChangedSinceApproval mirror the contract", () => {
    expect(qtyChangedReason(6, 7)).toBe("הכמות השתנתה מאז האישור (6 → 7)");
    expect(isQtyChangedReason(qtyChangedReason(1.234, 2))).toBe(true);
    expect(needsReapproval({ ...base, approvedQty: 6 })).toBe(true);
    expect(needsReapproval({ ...base, approvedQty: 7 })).toBe(false);
    expect(needsReapproval({ status: "reviewed", qty: 7, approvedQty: 6 })).toBe(false);
    expect(qtyChangedSinceApproval({ status: "reviewed", qty: 7, reasons: [qtyChangedReason(6, 7)] })).toBe(true);
    expect(qtyChangedSinceApproval({ status: "reviewed", qty: 7, reasons: [] })).toBe(false);
  });

  it("mock rebuild: an approved line whose qty changes drops to 'נבדק' with the reason; audited; export gate; filter", async () => {
    const b = await built({ blockExportOnRed: true });
    const lines = (await b.api.listBoqLines(PID)).items;
    const line = lines.find((l) => l.code === "4.02" && l.evidenceCount > 0) ?? lines.find((l) => l.evidenceCount > 0 && l.unit !== "קומפלט")!;
    await b.api.patchBoqLine(PID, line.id, { status: "reviewed" });
    const approved = await b.api.patchBoqLine(PID, line.id, { status: "approved" });
    expect(approved.approvedQty).toBe(line.qty);
    // a drawing correction that removes one of its items → the mock re-derives (like the auto rebuild)
    const ev = (await b.api.getBoqLineEvidence(PID, line.id)).items[0]!;
    await b.api.createCorrection(PID, {
      kind: "reject", sheetId: ev.sheetId, versionId: ev.versionId, anchorMm: { x: 1, y: 1 }, radiusMm: 3, detectionId: ev.detectionId,
      signature: null, class: null, itemCode: null, linkGroupId: null, geometry: null, quantity: null, unit: null, roomId: null, floor: null, reason: null,
    });
    const after = await until(
      async () => (await b.api.listBoqLines(PID)).items.find((l) => l.id === line.id)!,
      (l) => l.status !== "approved",
    );
    expect(after.status).toBe("reviewed");
    expect(after.approvedBy ?? null).toBeNull();
    expect(after.reasons?.[0]).toBe(qtyChangedReason(line.qty, after.qty));
    expect(qtyChangedSinceApproval(after)).toBe(true);
    expect(filterLines([after, ...lines.filter((l) => l.id !== line.id)], EMPTY_FILTERS, "qtyChanged").map((l) => l.id)).toEqual([line.id]);
    const audit = (await b.api.listAudit(ORG, { entity: "boqLines" } as never)).items;
    expect(audit.some((e) => e.action === "approval_invalidated" && e.entityId === line.id)).toBe(true);
    // re-approval clears the chip and sets a new baseline
    const again = await b.api.patchBoqLine(PID, line.id, { status: "approved" });
    expect((again.reasons ?? []).some(isQtyChangedReason)).toBe(false);
    expect(again.approvedQty).toBe(after.qty);
  });

  it("the chip shows the change as an LTR island", () => {
    render(<ReasonChip code={qtyChangedReason(15, 16)} />);
    const chip = document.querySelector("[data-reason=QTY_CHANGED_SINCE_APPROVAL]")!;
    expect(chip).toHaveTextContent("הכמות השתנתה מאז האישור(15 → 16)"); // " מאז האישור" is sr-only (narrow rows)
    expect(chip).toHaveAttribute("title", expect.stringContaining(qtyChangedReason(15, 16)));
    expect(chip.querySelector("bdi[dir=ltr]")).toHaveTextContent("(15 → 16)");
  });
});

describe("Stage 10: library state (A-LIVE-01)", () => {
  it("derives imported / default / none from the items' source", async () => {
    expect(librarySourceOf(undefined)).toBeNull();
    expect(librarySourceOf([])).toBe("none");
    expect(librarySourceOf([{ source: "default" }, { source: "default" }])).toBe("default");
    expect(librarySourceOf([{ source: "default" }, { source: "import" }])).toBe("imported");
    for (const mode of ["imported", "default", "none"] as const) {
      const b = createMockBackend({ latencyMs: 0, devIndex: false, libraryMode: mode });
      expect(librarySourceOf((await b.api.listLibraryItems(ORG, { limit: 500 })).items)).toBe(mode);
    }
  });

  it("hub + BOQ panel explain the default library / no library, with a link to import", async () => {
    await renderApp("/projects/p-noah", { signedIn: true, libraryMode: "none", boqPrebuilt: true });
    const note = await screen.findByRole("note", {}, WAIT).then(() => document.querySelector("[data-library-notice]")!);
    await waitFor(() => expect(document.querySelector("[data-library-notice=none]")).not.toBeNull(), WAIT);
    expect(document.querySelector("[data-library-notice=none]")).toHaveTextContent("לארגון אין עדיין ספריית סעיפים.");
    expect(within(document.querySelector<HTMLElement>("[data-library-notice=none]")!).getByRole("link", { name: "ייבוא כתב כמויות קודם" })).toHaveAttribute("href", "/library?import=1");
    void note;
  });

  it("default library: the notice names the shipped chapters; imported: no notice", async () => {
    const r = await renderApp("/projects/p-noah", { signedIn: true, libraryMode: "default" });
    await waitFor(() => expect(document.querySelector("[data-library-notice=default]")).not.toBeNull(), WAIT);
    expect(document.querySelector("[data-library-notice=default]")).toHaveTextContent("כתב הכמויות נבנה מספריית ברירת המחדל.");
    r.unmount();
    await renderApp("/projects/p-noah", { signedIn: true });
    await screen.findByRole("heading", { name: "בית משפחת נח", level: 1 }, WAIT);
    await new Promise((r2) => setTimeout(r2, 50));
    expect(document.querySelector("[data-library-notice]")).toBeNull();
  });

  it("/library?import=1 opens the import dialog", async () => {
    await renderApp("/library?import=1", { signedIn: true });
    expect(await screen.findByRole("dialog", { name: "ייבוא כתב כמויות קודם" }, WAIT)).toBeInTheDocument();
  });
});

describe("Stage 10: revised upload + re-upload of a failed set (A-API-05, A-UI-05)", () => {
  it("finalize with replacesSheetSetId supersedes the old set and drops its sheets", async () => {
    const b = createMockBackend({ latencyMs: 0, uploadTickMs: 5, jobTickMs: 5, devIndex: false });
    const rows0 = await new Promise<{ sheet: { id: string; sheetSetId: string } }[]>((r) => b.realtime.sheets(ORG, PID, r, () => {}));
    const old = rows0[0]!.sheet.sheetSetId;
    const target = await b.api.createUpload(PID, { filename: "rev-B.pdf", sizeBytes: 1000 });
    await b.uploads.start(target.storagePath, new Blob(["%PDF-1.7"]), target.contentType, () => {}).done;
    const res = await b.api.finalizeUpload(PID, { uploadToken: target.uploadToken, name: "rev-B.pdf", replacesSheetSetId: old });
    expect(res.sheetSet.replacesSheetSetId).toBe(old);
    const sets = await new Promise<{ id: string; status: string; supersededBySetId?: string | null }[]>((r) => b.realtime.sheetSets(ORG, PID, r, () => {}));
    expect(sets.find((s) => s.id === old)).toMatchObject({ status: "superseded", supersededBySetId: res.sheetSet.id });
    const rows1 = await new Promise<{ sheet: { sheetSetId: string } }[]>((r) => b.realtime.sheets(ORG, PID, r, () => {}));
    expect(rows1.some((r) => r.sheet.sheetSetId === old)).toBe(false);
    expect(rows1.some((r) => r.sheet.sheetSetId === res.sheetSet.id)).toBe(true);
    // twice → 409; unknown → 404
    const t2 = await b.api.createUpload(PID, { filename: "rev-C.pdf", sizeBytes: 1000 });
    await b.uploads.start(t2.storagePath, new Blob(["%PDF-1.7"]), t2.contentType, () => {}).done;
    await expect(b.api.finalizeUpload(PID, { uploadToken: t2.uploadToken, replacesSheetSetId: old })).rejects.toMatchObject({ status: 409 });
    await expect(b.api.finalizeUpload(PID, { uploadToken: t2.uploadToken, replacesSheetSetId: "nope" })).rejects.toMatchObject({ status: 404 });
  });

  it("hub upload dialog: 'מחליף את סט X' is offered; the upload carries replacesSheetSetId", async () => {
    const user = userEvent.setup({ delay: null });
    const { backend } = await renderApp("/projects/p-noah", { signedIn: true, devIndex: false });
    const fin = vi.spyOn(backend.api, "finalizeUpload");
    await user.click(await screen.findByRole("button", { name: "העלאת שרטוטים" }, WAIT));
    const dlg = await screen.findByRole("dialog", { name: "העלאת שרטוטים" });
    const pick = within(dlg).getByLabelText("מה הקבצים האלה?") as HTMLSelectElement;
    expect(pick.value).toBe("");
    const opt = pick.options[1]!;
    expect(opt.textContent).toMatch(/^מחליף את סט /);
    await user.selectOptions(pick, opt.value);
    expect(within(dlg).getByText(/הגיליונות שלו יוחלפו בגיליונות החדשים/)).toBeInTheDocument();
    expect(await axe(dlg)).toHaveNoViolations();
    const input = within(dlg).getByTestId("file-input") as HTMLInputElement;
    expect(input.multiple).toBe(false);
    await user.upload(input, new File(["%PDF-1.7\n%âãÏÓ\n1 0 obj\n"], "rev.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(fin).toHaveBeenCalledWith(PID, expect.objectContaining({ replacesSheetSetId: opt.value })), WAIT);
    expect(within(dlg).getByText(`מחליף את ${opt.textContent!.replace(/^מחליף את סט /, "")}`)).toBeInTheDocument();
  });

  it("a failed set offers 'העלה מחדש' (named after the file) and the re-upload replaces it", async () => {
    const user = userEvent.setup({ delay: null });
    const { backend } = await renderApp("/projects/p-levi", { signedIn: true, devIndex: false });
    const fin = vi.spyOn(backend.api, "finalizeUpload");
    const input = (await screen.findAllByTestId("file-input", {}, WAIT))[0] as HTMLInputElement;
    await user.upload(input, new File(["%PDF-1.7\n%âãÏÓ\n1 0 obj\n"], "bad-encrypted.pdf", { type: "application/pdf" }));
    const again = await screen.findByRole("button", { name: "העלה מחדש את bad-encrypted.pdf" }, { timeout: 20_000 });
    const failedSet = again.getAttribute("data-reupload")!;
    expect(failedSet).toBeTruthy();
    await user.upload(screen.getByTestId("reupload-input"), new File(["%PDF-1.7\n%âãÏÓ\n1 0 obj\n"], "good.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(fin).toHaveBeenLastCalledWith("p-levi", expect.objectContaining({ replacesSheetSetId: failedSet })), WAIT);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^העלה מחדש/ })).toBeNull(), { timeout: 20_000 });
    expect(document.querySelector("[data-set-status=superseded]")).not.toBeNull();
  });
});

describe("Stage 10: members (A-API-01) + MFA/reauth (A-API-02)", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await import("./settings/SettingsLayout");
    await import("./settings/MembersPage");
    await import("./settings/OrgSettingsPage");
  }, 60_000);

  it("mock API: invite (link once, pending), role change, remove, last admin kept, audited, recent auth required", async () => {
    const auth = createMockAuth({ persist: false, latencyMs: 0 });
    setAuthService(auth);
    await auth.signInWithPassword("admin@studio.co.il", "correct-horse-battery");
    const b = createMockBackend({ latencyMs: 0, devIndex: false });
    const list0 = (await b.api.listMembers(ORG)).members;
    expect(list0.find((m) => m.email === "admin@studio.co.il")).toMatchObject({ role: "admin", status: "active" });
    const inv = await b.api.inviteMember(ORG, { email: "New@Example.com", role: "reviewer" });
    expect(inv.member).toMatchObject({ email: "new@example.com", status: "pending", role: "reviewer", uid: null });
    expect(inv.inviteUrl).toMatch(new RegExp(`/invite/${inv.member.id}$`));
    await expect(b.api.inviteMember(ORG, { email: "new@example.com", role: "editor" })).rejects.toMatchObject({ code: "already_member" });
    await expect(b.api.inviteMember(ORG, { email: "nope", role: "editor" })).rejects.toMatchObject({ status: 400 });
    const lea = await b.api.patchMember(ORG, "uid-lea", { role: "viewer" });
    expect(lea.role).toBe("viewer");
    const me = list0.find((m) => m.email === "admin@studio.co.il")!;
    await expect(b.api.patchMember(ORG, me.id, { role: "editor" })).rejects.toMatchObject({ code: "last_admin" });
    await expect(b.api.removeMember(ORG, me.id)).rejects.toMatchObject({ code: "last_admin" });
    await b.api.removeMember(ORG, inv.member.id);
    expect((await b.api.listMembers(ORG)).members.some((m) => m.id === inv.member.id)).toBe(false);
    const audit = (await b.api.listAudit(ORG, {} as never)).items.filter((e) => e.actor?.uid === me.uid && ["members", "invites"].includes(e.entity));
    expect(audit.map((e) => `${e.entity}/${e.action}`).sort()).toEqual(["invites/revoke", "members/invite", "members/update_role"]);
    // A-UI-12: the signed-in user is the actor, not the demo name
    expect(audit[0]!.actor).toMatchObject({ uid: auth.getSession()!.uid });
    // an old sign-in → 403 recent_auth_required on every admin change
    const old = createMockAuth({ persist: false, latencyMs: 0, authAgeMs: 3_600_000 });
    setAuthService(old);
    await old.signInWithPassword("admin@studio.co.il", "correct-horse-battery");
    for (const call of [
      () => b.api.inviteMember(ORG, { email: "x@example.com", role: "viewer" }),
      () => b.api.patchMember(ORG, "uid-yossi", { role: "viewer" }),
      () => b.api.removeMember(ORG, "uid-yossi"),
      () => b.api.patchOrgSettings(ORG, { llmEnabled: true }),
      () => b.api.patchBoqRule(ORG, "r1", { enabled: false }),
      () => b.api.setDefaultBoqTemplate(ORG, "tpl_default"),
    ]) await expect(call()).rejects.toMatchObject({ status: 403, code: "recent_auth_required" });
  });

  it("members screen: invite → link once + copy, change role, remove behind a confirmation; axe", async () => {
    const user = userEvent.setup({ delay: null });
    const { backend } = await renderApp("/settings/members", { signedIn: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    expect(await screen.findByRole("link", { name: "חברי צוות" }, WAIT)).toHaveAttribute("aria-current", "page");
    const table = await screen.findByRole("table", { name: "חברי הצוות" }, WAIT);
    await waitFor(() => expect(within(table).getAllByRole("row").length).toBeGreaterThan(4));
    expect(within(table).getByText("(את/ה)")).toBeInTheDocument();
    expect(within(table).getByText("הוזמן, טרם הצטרף")).toBeInTheDocument();
    // validation
    await user.click(screen.getByRole("button", { name: "צור קישור הזמנה" }));
    expect(screen.getByText("כתבו כתובת אימייל תקינה.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("אימייל"), "kablan@example.com");
    await user.selectOptions(screen.getByLabelText("תפקיד"), "reviewer");
    await user.click(screen.getByRole("button", { name: "צור קישור הזמנה" }));
    const created = await screen.findByText(/נוצרה הזמנה ל-/, {}, WAIT);
    expect(created).toHaveTextContent("kablan@example.com");
    const url = screen.getByLabelText("קישור ההזמנה") as HTMLInputElement;
    expect(url).toHaveAttribute("readonly");
    expect(url).toHaveAttribute("dir", "ltr");
    await user.click(screen.getByRole("button", { name: "העתק קישור" }));
    expect(writeText).toHaveBeenCalledWith(url.value);
    // role change
    await user.selectOptions(screen.getByLabelText("התפקיד של יוסי מזרחי"), "editor");
    await waitFor(() => expect(toasts()).toContain("התפקיד של יוסי מזרחי שונה לעורך."), WAIT);
    // own role is locked
    expect(within(table).getAllByRole("combobox").find((c) => (c as HTMLSelectElement).disabled)).toBeTruthy();
    // remove → AlertDialog → removed
    await user.click(screen.getByRole("button", { name: "הסר את לאה לוי" }));
    const confirm = await screen.findByRole("alertdialog", { name: "להסיר את חבר הצוות?" });
    await user.click(within(confirm).getByRole("button", { name: "הסר" }));
    await waitFor(() => expect(toasts()).toContain("לאה לוי הוסר מהארגון."), WAIT);
    await waitFor(() => expect(screen.queryByText("לאה לוי")).toBeNull(), WAIT);
    expect((await backend.api.listMembers(ORG)).members.some((m) => m.id === "uid-lea")).toBe(false);
    expect(await axe(document.querySelector("main")!)).toHaveNoViolations();
  });

  it("an old sign-in: saving org settings asks to re-authenticate first, then saves (reused offboarding flow)", async () => {
    const user = userEvent.setup({ delay: null });
    const auth = createMockAuth({ persist: false, latencyMs: 0, authAgeMs: 3_600_000 });
    const { backend } = await renderApp("/settings", { signedIn: true, auth });
    const patch = vi.spyOn(backend.api, "patchOrgSettings");
    await user.click(await screen.findByRole("switch", { name: "שימוש במודל שפה חיצוני (LLM)" }, WAIT));
    await user.click(screen.getByRole("button", { name: "שמור שינויים" }));
    const box = await screen.findByRole("alertdialog", { name: "נדרשת כניסה מחדש" });
    expect(patch).not.toHaveBeenCalled();
    await user.type(within(box).getByLabelText("סיסמה"), "wrong");
    await user.click(within(box).getByRole("button", { name: "אמת" }));
    expect(await within(box).findByText("האימות נכשל. בדקו את הסיסמה ונסו שוב.")).toBeInTheDocument();
    await user.clear(within(box).getByLabelText("סיסמה"));
    await user.type(within(box).getByLabelText("סיסמה"), "correct-horse-battery");
    await user.click(within(box).getByRole("button", { name: "אמת" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(ORG, { llmEnabled: true }), WAIT);
    await waitFor(() => expect(toasts()).toContain("ההגדרות נשמרו ונרשמו ביומן."), WAIT);
    expect(screen.queryByRole("alertdialog", { name: "נדרשת כניסה מחדש" })).toBeNull();
  });

  it("a 403 recent_auth_required / mfa_required from the API maps onto the box / the MFA notice (rules toggle)", async () => {
    const user = userEvent.setup({ delay: null });
    const { backend } = await renderApp("/library?tab=rules", { signedIn: true });
    const spy = vi.spyOn(backend.api, "patchBoqRule").mockRejectedValueOnce(new ApiError(403, "mfa_required", "mfa"));
    const sw = (await screen.findAllByRole("switch", {}, WAIT))[0]!;
    await user.click(sw);
    expect(await screen.findByText(/הפעולה מחייבת כניסה עם אימות דו-שלבי/, {}, WAIT)).toBeInTheDocument();
    spy.mockRejectedValueOnce(new ApiError(403, "recent_auth_required", "old"));
    await user.click(sw);
    expect(await screen.findByRole("alertdialog", { name: "נדרשת כניסה מחדש" }, WAIT)).toBeInTheDocument();
  });
});

describe("Stage 10: HTTP adapters for the published contracts (members.ts, uploads.ts)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  it("members + pending invites → one list; invite / role / remove / revoke routes; last admin; accept; replacesSheetSetId", async () => {
    const { createHttpClient } = await import("@/api/http");
    const calls: [string, string, unknown][] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push([url, init.method ?? "GET", init.body ? JSON.parse(init.body as string) : undefined]);
      if (url.endsWith("/members") && !init.method) return json({ items: [{ uid: "u1", role: "admin", email: "a@x.com", createdAt: "t", isSelf: true }] });
      if (url.endsWith("/invites") && !init.method) return json({ items: [{ id: "i1", email: "p@x.com", role: "viewer", state: "pending", invitedBy: "u1", createdAt: "t", expiresAt: "t2" }, { id: "i2", email: "q@x.com", role: "viewer", state: "accepted", invitedBy: "u1", createdAt: "t", expiresAt: "t2" }] });
      if (url.endsWith("/invites")) return json({ invite: { id: "i3", email: "n@x.com", role: "editor", state: "pending", invitedBy: "u1", createdAt: "t", expiresAt: "t2" }, url: "https://app/invite/i3" }, 201);
      if (url.endsWith("/members/u1") && init.method === "PATCH") return json({ error: { code: "conflict", message: "the organization must keep at least one admin" } }, 409);
      if (url.endsWith("/accept")) return json({ orgId: "o", role: "editor", alreadyMember: false });
      return json({});
    });
    const api = createHttpClient(async () => "tok", "/api/v1", fetchImpl as unknown as typeof fetch);
    const list = (await api.listMembers("o")).members;
    expect(list.map((m) => [m.id, m.status])).toEqual([["u1", "active"], ["inv:i1", "pending"]]);
    const inv = await api.inviteMember("o", { email: "n@x.com", role: "editor" });
    expect(inv).toMatchObject({ inviteUrl: "https://app/invite/i3", member: { id: "inv:i3", status: "pending", email: "n@x.com" } });
    await expect(api.patchMember("o", "u1", { role: "viewer" })).rejects.toMatchObject({ status: 409, code: "last_admin" });
    await api.removeMember("o", "u2");
    await api.removeMember("o", "inv:i1");
    expect(await api.acceptInvite("i3")).toMatchObject({ alreadyMember: false });
    await api.finalizeUpload("p", { uploadToken: "t", replacesSheetSetId: "s1" });
    const routes = calls.map(([u, m]) => `${m} ${u}`);
    expect(routes).toEqual(expect.arrayContaining(["DELETE /api/v1/orgs/o/members/u2", "DELETE /api/v1/orgs/o/invites/i1", "POST /api/v1/invites/i3/accept", "POST /api/v1/projects/p/sheet-sets"]));
    expect(calls.find(([u]) => u.endsWith("/sheet-sets"))![2]).toEqual({ uploadToken: "t", replacesSheetSetId: "s1" });
  });
});
