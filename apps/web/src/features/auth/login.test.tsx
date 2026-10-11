import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";

describe("Login (mock mode)", () => {
  it("redirects unauthenticated users to /login", async () => {
    const { router } = await renderApp("/projects");
    expect(await screen.findByRole("heading", { name: "כניסה לכמותן" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("validates required fields in Hebrew", async () => {
    const user = userEvent.setup();
    await renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "כניסה" }));
    expect(await screen.findByText("צריך למלא אימייל")).toBeInTheDocument();
    expect(screen.getByText("צריך למלא סיסמה")).toBeInTheDocument();
    expect(screen.getByLabelText("אימייל")).toHaveAttribute("aria-invalid", "true");

    await user.type(screen.getByLabelText("אימייל"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "כניסה" }));
    expect(await screen.findByText("כתובת המייל לא תקינה")).toBeInTheDocument();
  });

  it("shows a Hebrew error on bad credentials", async () => {
    const user = userEvent.setup();
    await renderApp("/login");
    await user.type(await screen.findByLabelText("אימייל"), "dana@studio.co.il");
    await user.type(screen.getByLabelText("סיסמה"), "short");
    await user.click(screen.getByRole("button", { name: "כניסה" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("האימייל או הסיסמה לא נכונים.");
  });

  it("signs in with email + password and lands on the original page", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/projects");
    await user.type(await screen.findByLabelText("אימייל"), "dana@studio.co.il");
    await user.type(screen.getByLabelText("סיסמה"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "כניסה" }));
    expect(await screen.findByRole("heading", { name: "פרויקטים" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects");
  });

  it("magic-link mode sends a link and confirms", async () => {
    const user = userEvent.setup();
    await renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "קישור למייל" }));
    expect(screen.queryByLabelText("סיסמה")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("אימייל"), "dana@studio.co.il");
    await user.click(screen.getByRole("button", { name: "שלחו לי קישור כניסה" }));
    expect(await screen.findByRole("status")).toHaveTextContent("שלחנו קישור כניסה אל");
  });

  it("logs out from the user menu", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/projects", { signedIn: true });
    await user.click(await screen.findByRole("button", { name: "תפריט משתמש" }));
    await user.click(await screen.findByRole("menuitem", { name: /התנתקות/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("login screen has no axe violations", async () => {
    const { container } = await renderApp("/login");
    await screen.findByRole("heading", { name: "כניסה לכמותן" });
    expect(await axe(container)).toHaveNoViolations();
  });
});
