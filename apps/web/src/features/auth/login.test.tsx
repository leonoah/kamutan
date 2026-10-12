import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";
import { EMAIL_FOR_SIGN_IN_KEY, MOCK_EMAIL_LINK } from "./authService";

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

  it("signs in with Google", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "כניסה עם Google" }));
    expect(await screen.findByRole("heading", { name: "פרויקטים" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects");
  });

  it("email link: same device completes automatically on /auth/complete", async () => {
    localStorage.setItem(EMAIL_FOR_SIGN_IN_KEY, "dana@studio.co.il");
    const { router } = await renderApp(MOCK_EMAIL_LINK);
    expect(await screen.findByRole("heading", { name: "פרויקטים" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects");
    expect(localStorage.getItem(EMAIL_FOR_SIGN_IN_KEY)).toBeNull();
  });

  it("email link: another device asks for the email first", async () => {
    const user = userEvent.setup();
    await renderApp(MOCK_EMAIL_LINK);
    expect(await screen.findByText(/פתחתם את הקישור במכשיר אחר/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("אימייל"), "dana@studio.co.il");
    await user.click(screen.getByRole("button", { name: "השלמת הכניסה" }));
    expect(await screen.findByRole("heading", { name: "פרויקטים" })).toBeInTheDocument();
  });

  it("email link: invalid or expired link explains and links back", async () => {
    await renderApp("/auth/complete?foo=bar");
    expect(await screen.findByRole("alert")).toHaveTextContent("הקישור לא תקין או שפג תוקפו.");
    expect(screen.getByRole("link", { name: "חזרה למסך הכניסה" })).toHaveAttribute("href", "/login");
  });

  it("shows the no-organisation screen for users without membership", async () => {
    await renderApp("/projects", { signedIn: true, orgs: [] });
    expect(await screen.findByText("עוד לא שויכת לארגון.")).toBeInTheDocument();
  });

  it("magic-link mode sends a link and confirms", async () => {
    const user = userEvent.setup();
    await renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "קישור למייל" }));
    expect(screen.queryByLabelText("סיסמה")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("אימייל"), "dana@studio.co.il");
    await user.click(screen.getByRole("button", { name: "שלחו לי קישור כניסה" }));
    expect(await screen.findByRole("status")).toHaveTextContent("שלחנו קישור כניסה אל");
    expect(localStorage.getItem(EMAIL_FOR_SIGN_IN_KEY)).toBe("dana@studio.co.il");
    // Mock mode offers the link in-app; following it completes the sign-in.
    await user.click(screen.getByRole("link", { name: "פתיחת קישור הכניסה" }));
    expect(await screen.findByRole("heading", { name: "פרויקטים" })).toBeInTheDocument();
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
