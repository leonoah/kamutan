import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DrawingViewerProps } from "@kamutan/viewer";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";

const LAZY = { timeout: 10_000 };
vi.mock("@kamutan/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kamutan/viewer")>();
  return {
    ...actual,
    DrawingViewer: (p: DrawingViewerProps) => <div role="application" aria-label={p?.ariaLabel} dir="ltr" />,
  };
});

/** IA redesign: landing → projects → project hub (drawings + BOQ) → sheet analysis. */
describe("Landing page", () => {
  it("is the public root and sends visitors to /login", async () => {
    await renderApp("/");
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(/כתב כמויות/);
    expect(screen.getByRole("link", { name: "כניסה למערכת" })).toHaveAttribute("href", "/login");
  });

  it("offers the projects list to a signed-in user", async () => {
    await renderApp("/", { signedIn: true });
    expect(await screen.findByRole("link", { name: "לפרויקטים" })).toHaveAttribute("href", "/projects");
  });
});

describe("Project hub", () => {
  it("shows the drawings gallery next to the project BOQ, and filters the BOQ by a sheet", async () => {
    const user = userEvent.setup();
    await renderApp("/projects/p-noah", { signedIn: true });
    await screen.findByRole("heading", { level: 1, name: /נח/ });

    const gallery = await screen.findByRole("list", { name: "שרטוטים" });
    const tiles = within(gallery).getAllByRole("article");
    expect(tiles.length).toBeGreaterThan(1);
    // A ready tile links to the sheet analysis screen (level 3), not to the project review;
    // an unconfirmed one nudges to the confirm step first.
    const readyTile = tiles.find((a) => a.getAttribute("data-state") === "ready")!;
    expect(within(readyTile).getByRole("link", { name: "לניתוח" }).getAttribute("href")).toMatch(/^\/projects\/p-noah\/sheets\/noah-/);
    const toConfirm = tiles.find((a) => a.getAttribute("data-state") === "toConfirm")!;
    expect(within(toConfirm).getByRole("link", { name: "לאישור הגיליון" })).toHaveAttribute("href", "/projects/p-noah/sheets");

    // BOQ column: either an existing bill or the build empty state.
    const boq = screen.getByRole("region", { name: "כתב כמויות" });
    expect(boq).toBeInTheDocument();

    // Clicking a thumbnail filters the BOQ by that sheet.
    await user.click(within(tiles[0]!).getByRole("button", { name: /סנן את כתב הכמויות לפי/ }));
    expect(within(boq).getByText("מסונן לפי:")).toBeInTheDocument();
    await user.click(within(boq).getByRole("button", { name: "נקה סינון" }));
    expect(within(boq).queryByText("מסונן לפי:")).not.toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = await renderApp("/projects/p-noah", { signedIn: true });
    await screen.findByRole("list", { name: "שרטוטים" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("Sheet analysis route", () => {
  it("locks the workspace to one sheet and opens on the components map", async () => {
    await renderApp("/projects/p-noah/sheets/noah-eb8be8a3-p0", { signedIn: true });
    await screen.findByRole("application", { name: /^שרטוט ת\. חשמל \/ קומת קרקע/ }, LAZY);
    // Breadcrumb names the sheet; no sheet picker in the drawing header.
    const crumbs = screen.getByRole("navigation", { name: "מיקום" });
    expect(within(crumbs).getByText("ניתוח שרטוט")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "בחירת גיליון" })).not.toBeInTheDocument();
    // Default panel = ספירה לפי סוג.
    await waitFor(() => expect(screen.getByRole("tab", { name: "ספירה לפי סוג" })).toHaveAttribute("aria-selected", "true"), LAZY);
  });
});
