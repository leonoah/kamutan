import { render, screen } from "@testing-library/react";
import { axe } from "@/test/axe";
import { ConfidenceBadge, CONFIDENCE_GLYPH, levelFromDb } from "./ConfidenceBadge";

describe("ConfidenceBadge", () => {
  it.each([
    ["high", "מאומת"],
    ["mid", "סביר"],
    ["low", "לבדיקה"],
    ["unknown", "לא מוכר"],
    ["manual", "אושר ידנית"],
  ] as const)("level %s shows word + shape (never color alone)", (level, word) => {
    const { container } = render(<ConfidenceBadge level={level} />);
    expect(screen.getByText(word)).toBeInTheDocument();
    const shape = container.querySelector(`svg[data-shape="${level}"]`);
    expect(shape).not.toBeNull();
    expect(shape).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(`[data-level="${level}"]`)).toHaveClass("text-foreground");
  });

  it("uses distinct shapes ● ▲ ◆ for the three detection levels", () => {
    expect(CONFIDENCE_GLYPH.high).toBe("●");
    expect(CONFIDENCE_GLYPH.mid).toBe("▲");
    expect(CONFIDENCE_GLYPH.low).toBe("◆");
    const paths = (["high", "mid", "low"] as const).map((l) => {
      const { container } = render(<ConfidenceBadge level={l} />);
      return container.querySelector("svg")!.innerHTML;
    });
    expect(new Set(paths).size).toBe(3);
  });

  it("shows calibrated score only in the title, never as a percentage", () => {
    const { container } = render(<ConfidenceBadge level="mid" score={0.834} />);
    const el = container.querySelector("[data-level]")!;
    expect(el).toHaveAttribute("title", "ביטחון 0.83 · סביר");
    expect(el.textContent).not.toMatch(/%|0\.83/);
  });

  it("indicator variant keeps the word for screen readers", () => {
    render(<ConfidenceBadge level="low" variant="indicator" />);
    expect(screen.getByText("לבדיקה")).toHaveClass("sr-only");
  });

  it("maps DB enum green/yellow/red", () => {
    expect(levelFromDb("green")).toBe("high");
    expect(levelFromDb("yellow")).toBe("mid");
    expect(levelFromDb("red")).toBe("low");
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <div>
        {(["high", "mid", "low", "unknown", "manual"] as const).map((l) => (
          <ConfidenceBadge key={l} level={l} score={0.5} />
        ))}
        <ConfidenceBadge level="low" variant="indicator" />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
