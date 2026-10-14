import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DrawingViewerProps } from "@kamutan/viewer";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";

const seen: { props: DrawingViewerProps | null } = { props: null };
// The viewer is a lazy chunk; its first import can be slow on a loaded runner.
const LAZY = { timeout: 10_000 };
vi.mock("@kamutan/viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kamutan/viewer")>();
  return {
    ...actual,
    DrawingViewer: (p: DrawingViewerProps) => {
      seen.props = p;
      return <div role="application" aria-label={p.ariaLabel} dir="ltr" data-sheet-key={p.sheetKey} />;
    },
  };
});

describe("Review workspace: real viewer in the drawing pane", { timeout: 20_000 }, () => {
  it("opens the first sheet with detections (electrical ground) in the viewer with its tiles and paper size", async () => {
    await renderApp("/projects/p-noah/review", { signedIn: true });
    const drawing = await screen.findByRole("region", { name: "שרטוט" });
    const app = await within(drawing).findByRole("application", { name: /^שרטוט ת\. חשמל \/ קומת קרקע/ }, LAZY);
    expect(app).toHaveAttribute("dir", "ltr");
    expect(within(drawing).getByRole("button", { name: "בחירת גיליון" })).toHaveTextContent("ת. חשמל / קומת קרקע");
    await waitFor(() => expect(seen.props?.tiles).toBeTruthy());
    const tiles = seen.props!.tiles!;
    expect(tiles.levels).toBe(6);
    expect(seen.props!.sheet.widthMm).toBeCloseTo(420.2, 1);
    // signed URLs are fetched per block from the tiles-manifest endpoint
    await expect(Promise.resolve(tiles.tileUrl(5, 2, 3))).resolves.toBe(
      "/dev-artifacts/orgs/org-demo/projects/p-noah/sheets/noah-eb8be8a3-p0/versions/v1/tiles/5/2_3.webp",
    );
    expect(within(drawing).getByTestId("viewer-scale")).toHaveTextContent("1:50");
    // the 3-pane layout is still there
    expect(screen.getByRole("region", { name: "כתב כמויות" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "תור בדיקה" })).toBeInTheDocument();
  });

  it("sheet selector switches sheets and keeps the choice in the URL", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/projects/p-noah/review", { signedIn: true });
    const drawing = await screen.findByRole("region", { name: "שרטוט" });
    await user.click(await within(drawing).findByRole("button", { name: "בחירת גיליון" }));
    const items = await screen.findAllByRole("menuitemradio");
    expect(items).toHaveLength(6);
    await user.click(screen.getByRole("menuitemradio", { name: /ת\. אינסטלציה \/ קומת מרתף/ }));
    expect(await within(drawing).findByRole("application", { name: "שרטוט ת. אינסטלציה / קומת מרתף" }, LAZY)).toBeInTheDocument();
    expect(router.state.location.search).toBe("?sheet=noah-24ab0ea0-p0");
  });

  it("deep link ?sheet=&bbox= opens that sheet zoomed into the given paper-mm box", async () => {
    await renderApp("/projects/p-noah/review?sheet=noah-eb8be8a3-p0&bbox=12,197,103,250", { signedIn: true });
    await screen.findByRole("application", { name: "שרטוט ת. חשמל / קומת קרקע" }, LAZY);
    expect(seen.props!.initialViewMm).toEqual([12, 197, 103, 250]);
  });

  it("tool rail toggles tools and passes them to the viewer", async () => {
    const user = userEvent.setup();
    await renderApp("/projects/p-noah/review", { signedIn: true });
    const rail = await screen.findByRole("toolbar", { name: "כלי תיקון" });
    await user.click(within(rail).getByRole("button", { name: "לאסו (L)" }));
    expect(seen.props!.tool).toBe("lasso");
    expect(within(rail).getByRole("button", { name: "לאסו (L)" })).toHaveAttribute("aria-pressed", "true");
  });

  it("has no axe violations with the viewer mounted", async () => {
    const { container } = await renderApp("/projects/p-noah/review", { signedIn: true });
    await screen.findByRole("application", { name: /^שרטוט/ }, LAZY);
    expect(await axe(container)).toHaveNoViolations();
  });
});
