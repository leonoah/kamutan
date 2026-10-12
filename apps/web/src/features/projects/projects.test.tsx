import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";

describe("Projects list", () => {
  it("shows the spec empty state when there are no projects", async () => {
    await renderApp("/projects", { signedIn: true, projects: [] });
    expect(await screen.findByText("עוד אין פרויקטים.")).toBeInTheDocument();
    expect(screen.getByText("גררו לכאן סט שרטוטים ונתחיל.")).toBeInTheDocument();
  });

  it("lists projects with status, verified % and next action", async () => {
    await renderApp("/projects", { signedIn: true });
    const row = (await screen.findByRole("link", { name: "בית משפחת נח" })).closest("tr")!;
    expect(within(row).getByText("בבדיקה")).toBeInTheDocument();
    expect(within(row).getByText("87%")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /לסביבת הבדיקה/ })).toHaveAttribute("href", "/projects/p-noah/review");
  });

  it("shows live processing progress from the org jobs listener", async () => {
    const { backend } = await renderApp("/projects", { signedIn: true, jobTickMs: 10_000 });
    const row = (await screen.findByRole("link", { name: "דירת לוי — שיפוץ מטבח ורחצה" })).closest("tr")!;
    expect(within(row).getByText("טיוטה")).toBeInTheDocument();
    const up = await backend.api.createUpload("p-levi", { filename: "a.pdf", sizeBytes: 5 });
    await new Promise<void>((resolve) => {
      const h = backend.uploads.start(up.storagePath, new File(["%PDF-"], "a.pdf"), up.contentType, () => {});
      void h.done.then(resolve);
    });
    await act(async () => {
      await backend.api.finalizeUpload("p-levi", { uploadToken: up.uploadToken });
    });
    expect(await within(row).findByText("בעיבוד · 0%")).toBeInTheDocument();
  });

  it("creates a project from the dialog and navigates to it", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/projects", { signedIn: true, projects: [] });
    await user.click((await screen.findAllByRole("button", { name: "פרויקט חדש" }))[0]!);
    const dialog = await screen.findByRole("dialog", { name: "פרויקט חדש" });
    await user.click(within(dialog).getByRole("button", { name: "צור פרויקט" }));
    expect(await within(dialog).findByText("צריך לתת לפרויקט שם")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("שם הפרויקט"), "וילה כהן");
    await user.type(within(dialog).getByLabelText("כתובת"), "הרצל 1, חיפה");
    await user.click(within(dialog).getByRole("button", { name: "צור פרויקט" }));
    expect(await screen.findByRole("heading", { level: 1, name: "וילה כהן" })).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/projects\/p-/);
    await waitFor(() => expect(screen.getByText('הפרויקט "וילה כהן" נוצר.')).toBeInTheDocument());
  });

  it("projects list and create dialog have no axe violations", async () => {
    const user = userEvent.setup();
    const { baseElement } = await renderApp("/projects", { signedIn: true });
    await screen.findByRole("link", { name: "בית משפחת נח" });
    expect(await axe(baseElement)).toHaveNoViolations();
    await user.click(screen.getByRole("button", { name: "פרויקט חדש" }));
    await screen.findByRole("dialog");
    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it("empty state has no axe violations", async () => {
    const { container } = await renderApp("/projects", { signedIn: true, projects: [] });
    await screen.findByText("עוד אין פרויקטים.");
    expect(await axe(container)).toHaveNoViolations();
  });
});
