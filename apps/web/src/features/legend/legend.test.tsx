import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "@/test/axe";
import { renderApp } from "@/test/utils";

async function open() {
  const utils = await renderApp("/projects/p-noah/legend", { signedIn: true });
  await screen.findByRole("heading", { level: 1, name: "אישור מקרא" });
  await screen.findByRole("region", { name: "ת. חשמל / קומת קרקע" });
  return utils;
}

const rowOf = (label: string) => screen.getByRole("button", { name: `אשר את "${label}"` }).closest("tr")!;

describe("Legend confirmation (S08)", { timeout: 20_000 }, () => {
  it("lists legend rows per sheet: crop, editable OCR label, Hebrew class, confidence badge, actions", async () => {
    await open();
    const elec = screen.getByRole("region", { name: "ת. חשמל / קומת קרקע" });
    expect(screen.getByRole("region", { name: "ת. תאורה / קומת קרקע" })).toBeInTheDocument();
    const rows = within(elec).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(8);
    const first = rows[0]!;
    expect(within(first).getByRole("img", { name: "סמל המקרא: שקע כפול" })).toBeInTheDocument();
    expect(within(first).getByRole("textbox", { name: "טקסט שורת המקרא 1" })).toHaveValue("שקע כפול");
    const select = within(first).getByRole("combobox", { name: "סוג לשורת המקרא 1" });
    expect(select).toHaveValue("socket_double");
    expect(within(select).getByRole("option", { name: "שקע כפול" })).toBeInTheDocument();
    expect(within(first).getByText("מאומת")).toBeInTheDocument();
    // no suggestion → red, and אשר stays disabled until a class is chosen
    const last = rows[7]!;
    expect(within(last).getByText("לבדיקה")).toBeInTheDocument();
    expect(within(last).getByRole("button", { name: /^אשר את/ })).toBeDisabled();
    expect(screen.getByText("0 מתוך 13 אושרו")).toBeInTheDocument();
  });

  it("אשר confirms a row (PATCH confirm) and updates the progress", async () => {
    const user = userEvent.setup();
    const { api } = await open();
    const spy = vi.spyOn(api, "patchLegendEntry");
    await user.click(screen.getByRole("button", { name: 'אשר את "שקע בודד"' }));
    expect(spy).toHaveBeenCalledWith("p-noah", "le_noah-eb8be8a3-p0_2", { action: "confirm" });
    await waitFor(() => expect(screen.getByText("1 מתוך 13 אושרו")).toBeInTheDocument());
    const row = screen.getByRole("button", { name: "ערוך — שקע בודד" }).closest("tr")!;
    expect(row).toHaveAttribute("data-status", "confirmed");
    expect(within(row).getByText("אושר ידנית")).toBeInTheDocument();
  });

  it("choosing another class + editing the label sends reassign with the label", async () => {
    const user = userEvent.setup();
    const { api } = await open();
    const spy = vi.spyOn(api, "patchLegendEntry");
    const row = rowOf("אביזר מוגן מים IP44");
    const input = within(row).getByRole("textbox");
    await user.clear(input);
    await user.type(input, "שקע מוגן מים IP44");
    await user.selectOptions(within(row).getByRole("combobox"), "socket_single");
    await user.click(within(row).getByRole("button", { name: /^אשר את/ }));
    expect(spy).toHaveBeenCalledWith("p-noah", "le_noah-eb8be8a3-p0_8", { action: "reassign", class: "socket_single", label: "שקע מוגן מים IP44" });
    await waitFor(() => expect(screen.getByText("שקע מוגן מים IP44")).toBeInTheDocument());
  });

  it("התעלם marks a row as not-an-item", async () => {
    const user = userEvent.setup();
    const { api } = await open();
    const spy = vi.spyOn(api, "patchLegendEntry");
    await user.click(screen.getByRole("button", { name: 'התעלם מ-"הזנה לדוד חשמל"' }));
    expect(spy).toHaveBeenCalledWith("p-noah", "le_noah-eb8be8a3-p0_7", { action: "ignore" });
    await waitFor(() => expect(screen.getByText("לא פריט", { selector: "td span" })).toBeInTheDocument());
  });

  it("'אשר את כל הירוקים' confirms every green suggestion at once", async () => {
    const user = userEvent.setup();
    const { api } = await open();
    const spy = vi.spyOn(api, "patchLegendEntry");
    await user.click(screen.getByRole("button", { name: "אשר את כל הירוקים" }));
    await waitFor(() => expect(screen.getByText("8 מתוך 13 אושרו")).toBeInTheDocument());
    expect(spy).toHaveBeenCalledTimes(8);
    expect(spy.mock.calls.every((c) => (c[2] as { action: string }).action === "confirm")).toBe(true);
    expect(screen.getByRole("button", { name: "אשר את כל הירוקים" })).toBeDisabled();
  });

  it("rolls back and shows an error toast when the API refuses", async () => {
    const user = userEvent.setup();
    const { api } = await open();
    vi.spyOn(api, "patchLegendEntry").mockRejectedValueOnce(new Error("nope"));
    await user.click(screen.getByRole("button", { name: 'אשר את "שקע כפול"' }));
    expect(await screen.findByText("לא הצלחנו לשמור. נסו שוב.")).toBeInTheDocument();
    expect(screen.getByText("0 מתוך 13 אושרו")).toBeInTheDocument();
    expect(rowOf("שקע כפול")).toHaveAttribute("data-status", "suggested");
  });

  it("is linked from the sheets page and the processing panel", async () => {
    await renderApp("/projects/p-noah/sheets", { signedIn: true });
    expect(await screen.findByRole("link", { name: "אישור מקרא" })).toHaveAttribute("href", "/projects/p-noah/legend");
  });

  it("processing panel offers the legend screen when sheets have a legend", async () => {
    await renderApp("/projects/p-noah", { signedIn: true });
    expect(await screen.findByText("נמצאו מקראים ב-2 גיליונות — כדאי לאשר אותם")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "אישור מקרא" })).toHaveAttribute("href", "/projects/p-noah/legend");
  });

  it("empty state when no legend was found", async () => {
    await renderApp("/projects/p-noah/legend", { signedIn: true, understandingFixture: false });
    expect(await screen.findByText(/עוד לא נמצאו מקראים/)).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = await open();
    expect(await axe(container)).toHaveNoViolations();
  });
});
