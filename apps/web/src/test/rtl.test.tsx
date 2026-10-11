import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import i18n, { applyDocumentDirection } from "@/i18n";
import { Ltr } from "@/components/Ltr";
import { MixedText } from "@/features/review/ReviewPage";
import { formatDate, formatQuantity } from "@/lib/format";

describe("RTL root", () => {
  it('index.html ships <html dir="rtl" lang="he">', () => {
    const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.documentElement.getAttribute("dir")).toBe("rtl");
    expect(doc.documentElement.getAttribute("lang")).toBe("he");
    expect(html).toMatch(/family=Heebo/);
  });

  it("Hebrew is the default language and sets dir/lang on <html>", () => {
    expect(i18n.language).toBe("he");
    applyDocumentDirection();
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(document.documentElement).toHaveAttribute("lang", "he");
  });

  it("switching to the English scaffold flips to ltr and back", async () => {
    await i18n.changeLanguage("en");
    expect(document.documentElement).toHaveAttribute("dir", "ltr");
    expect(document.documentElement).toHaveAttribute("lang", "en");
    await i18n.changeLanguage("he");
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
  });
});

describe("bidi isolation of codes and units", () => {
  it("<Ltr> isolates item codes as text (4.10 stays 4.10)", () => {
    render(<p>סעיף <Ltr>4.10</Ltr> שקע</p>);
    const el = screen.getByText("4.10");
    expect(el.tagName).toBe("BDI");
    expect(el).toHaveAttribute("dir", "ltr");
  });

  it("MixedText wraps 16A, H=65 and 1:50 in ltr <bdi>", () => {
    const { container } = render(<p><MixedText text="שקע כח 16A להוסיף מחלף H=65 בקנ״מ 1:50" /></p>);
    const isolated = [...container.querySelectorAll('bdi[dir="ltr"]')].map((b) => b.textContent);
    expect(isolated).toEqual(["16A", "H=65", "1:50"]);
  });

  it("formats numbers with Western digits and dates as dd.mm.yyyy", () => {
    expect(formatQuantity(1234.5, "מ\"א")).toBe("1,234.50");
    expect(formatQuantity(15, "יח'")).toBe("15");
    expect(formatDate("2026-10-11T12:00:00Z")).toBe("11.10.2026");
  });
});
