import { screen } from "@testing-library/react";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";

describe("Review workspace skeleton", () => {
  it("renders the three panes in RTL order with an LTR drawing", async () => {
    const { container } = await renderApp("/projects/p-noah/review", { signedIn: true });
    const boq = await screen.findByRole("region", { name: "כתב כמויות" });
    const drawing = screen.getByRole("region", { name: "שרטוט" });
    const queue = screen.getByRole("region", { name: "תור בדיקה" });
    // DOM order = inline order; in RTL the first grid column is on the right.
    const order = [boq, drawing, queue].map((el) => [...container.querySelectorAll("section")].indexOf(el as HTMLElement));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(drawing.querySelector('[dir="ltr"]')).not.toBeNull();
    expect(screen.getByRole("heading", { name: "פרק 04 – עבודות חשמל" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "בית משפחת נח" })).toBeInTheDocument();
  });

  it("keeps item codes as text with ltr isolation (4.10 not 4.1)", async () => {
    await renderApp("/projects/p-noah/review", { signedIn: true });
    const boq = await screen.findByRole("region", { name: "כתב כמויות" });
    const code = [...boq.querySelectorAll("bdi")].find((b) => b.textContent === "4.10");
    expect(code).toBeDefined();
    expect(code).toHaveAttribute("dir", "ltr");
  });

  it("has no axe violations", async () => {
    const { container } = await renderApp("/projects/p-noah/review", { signedIn: true });
    await screen.findByRole("region", { name: "תור בדיקה" });
    expect(await axe(container)).toHaveNoViolations();
  });
});
