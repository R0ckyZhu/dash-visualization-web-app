import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../src/App";
import { ScopeDialog } from "../src/components/ScopeDialog";
import { valuesChanged } from "../src/state/valueComparison";
import { dashApi } from "../src/api/dashApi";

vi.mock("../src/graph/StatechartGraph", () => ({
  StatechartGraph: ({ activeStateIds }: { activeStateIds: string[] }) => (
    <div data-testid="graph">{activeStateIds.join(",")}</div>
  ),
}));
vi.mock("../src/graph/KripkeGraph", () => ({
  KripkeGraph: () => <div>Kripke canvas</div>,
}));
vi.mock("../src/api/dashApi", () => ({
  dashApi: {
    examples: vi.fn(),
    inspect: vi.fn(),
    init: vi.fn(),
    step: vi.fn(),
    nextInitSolution: vi.fn(),
    nextSolution: vi.fn(),
    altTrans: vi.fn(),
    source: vi.fn(),
  },
}));
const meta = { sessionId: "default", sessionRevision: 1 };
const model = {
  rootName: "Light",
  states: ["On", "Off"].map((name) => ({
    id: `Light/${name}`,
    kind: "BASIC",
    parent: null,
    children: [],
    isDefault: name === "On",
    params: [],
  })),
  transitions: [{ id: "Light/Toggle", from: "Light/On", to: "Light/Off" }],
  events: [],
  vars: [],
  buffers: [],
};
const first = {
  __conf0: ["Light_On"],
  __taken0: [],
  value: ["0"],
  __stable: ["True"],
};
const second = {
  __conf0: ["Light_Off"],
  __taken0: ["Light_Toggle"],
  value: ["1"],
  __stable: ["True"],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dashApi.examples).mockResolvedValue({
    examples: [{ name: "Test light", path: "test.dsh", group: "Examples" }],
    allowLocalModelPaths: true,
  });
  vi.mocked(dashApi.inspect).mockResolvedValue({
    ...meta,
    model,
    scopeSigs: [],
    commandCount: 1,
  });
  vi.mocked(dashApi.init).mockResolvedValue({
    ...meta,
    satisfiable: true,
    snapshots: [first],
  });
  vi.mocked(dashApi.step).mockResolvedValue({
    ...meta,
    satisfiable: true,
    snapshots: [first, second],
  });
});
async function openAndStart() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /Test light/ }));
  await user.click(
    await screen.findByRole("button", { name: "Start simulation" }),
  );
  await screen.findByText("Initial snapshot S1 found.");
  return user;
}
async function stepAndOpenTrace() {
  const user = await openAndStart();
  await user.click(screen.getByRole("button", { name: "Step →" }));
  await screen.findByText("Stepped to S2.");
  await user.click(screen.getByRole("button", { name: "Trace View" }));
  return { user, region: screen.getByRole("region", { name: "Trace table" }) };
}
describe("scope editor", () => {
  it("keeps changes local until Start simulation and submits exact edited values", async () => {
    const apply = vi.fn();
    const close = vi.fn();
    const user = userEvent.setup();
    render(
      <ScopeDialog
        scopeSigs={["PID"]}
        scopes={{ PID: 2 }}
        hasRun
        onApply={apply}
        onClose={close}
      />,
    );
    const input = screen.getByRole("spinbutton", { name: "PID" });
    await user.clear(input);
    await user.type(input, "3");
    expect(apply).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Start simulation" }));
    expect(apply).toHaveBeenCalledExactlyOnceWith({ PID: 3 });
  });
  it("Cancel never commits and invalid values cannot start", async () => {
    const apply = vi.fn();
    const close = vi.fn();
    const user = userEvent.setup();
    render(
      <ScopeDialog
        scopeSigs={["PID"]}
        scopes={{ PID: 2 }}
        hasRun
        onApply={apply}
        onClose={close}
      />,
    );
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "21" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Start simulation",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });
});
describe("demo shell", () => {
  it("offers only the demo views and no mode, configure or assistant controls", async () => {
    await openAndStart();
    for (const name of [
      "Static Model Hierarchy",
      "Trace View",
      "Model Source",
    ])
      expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Configure/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Assistant/ })).toBeNull();
    expect(screen.getByText("Explored Kripke Structure")).toBeTruthy();
  });
  it("treats snapshots of a model without a stable field as stable", async () => {
    const { __stable: _omitted, ...withoutStable } = first;
    vi.mocked(dashApi.init).mockResolvedValue({
      ...meta,
      satisfiable: true,
      snapshots: [withoutStable],
    });
    await openAndStart();
    expect(screen.getByText("S1 · Stable")).toBeTruthy();
  });
});
describe("trace view", () => {
  it("puts snapshots in columns and highlights where a selected state is active", async () => {
    const { user, region } = await stepAndOpenTrace();
    const headers = within(region)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual(["Snapshot", "S1", "S2"]);
    await user.click(within(region).getByRole("button", { name: "Off" }));
    const row = within(region)
      .getByRole("button", { name: "Off" })
      .closest("tr")!;
    expect(row.className).toContain("row-selected");
    const cells = row.querySelectorAll("td");
    expect(cells[0].className).not.toContain("cell-hit");
    expect(cells[1].className).toContain("cell-hit");
  });
  it("filters rows by name and by kind", async () => {
    const { user, region } = await stepAndOpenTrace();
    expect(within(region).getByText("value")).toBeTruthy();
    await user.type(
      screen.getByRole("searchbox", { name: "Filter rows" }),
      "trans",
    );
    expect(within(region).queryByText("value")).toBeNull();
    expect(within(region).getByText("Transition taken")).toBeTruthy();
    await user.clear(screen.getByRole("searchbox", { name: "Filter rows" }));
    await user.click(screen.getByRole("button", { name: "Variables" }));
    expect(within(region).queryByText("value")).toBeNull();
  });
});
describe("simulation request integrity", () => {
  it("opens without solving, then always solves in simplified mode", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Test light/ }));
    await screen.findByRole("button", { name: "Start simulation" });
    expect(dashApi.init).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Start simulation" }));
    await waitFor(() =>
      expect(dashApi.init).toHaveBeenCalledExactlyOnceWith({
        mode: "simplified",
        sigScopes: {},
      }),
    );
  });
  it("steps from the selected snapshot and selecting a trace column changes the next Step origin", async () => {
    const { user, region } = await stepAndOpenTrace();
    expect(dashApi.step).toHaveBeenLastCalledWith({
      state: first,
      mode: "simplified",
      sigScopes: {},
    });
    await user.click(within(region).getByRole("button", { name: "S1" }));
    await user.click(
      screen.getByRole("button", { name: "Static Model Hierarchy" }),
    );
    expect(screen.getByTestId("graph").textContent).toBe("Light/On");
    await user.click(screen.getByRole("button", { name: "Step →" }));
    await waitFor(() => expect(dashApi.step).toHaveBeenCalledTimes(2));
    expect(dashApi.step).toHaveBeenLastCalledWith({
      state: first,
      mode: "simplified",
      sigScopes: {},
    });
  });
  it("shows actual pending operation and prevents a second solve", async () => {
    const user = await openAndStart();
    let complete!: (value: any) => void;
    vi.mocked(dashApi.step).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await user.click(screen.getByRole("button", { name: "Step →" }));
    expect(screen.getByRole("status").textContent).toContain(
      "Stepping from S1...",
    );
    await user.click(screen.getByRole("button", { name: "Step →" }));
    expect(dashApi.step).toHaveBeenCalledOnce();
    complete({ ...meta, satisfiable: true, snapshots: [first, second] });
    await screen.findByText("Stepped to S2.");
  });
  it("starts from the model's default scopes; Cancel keeps the run and Start uses fresh scopes", async () => {
    vi.mocked(dashApi.inspect).mockResolvedValue({
      ...meta,
      model,
      scopeSigs: ["PID"],
      defaultScopes: { PID: 2 },
      commandCount: 1,
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Test light/ }));
    expect(
      ((await screen.findByRole("spinbutton")) as HTMLInputElement).value,
    ).toBe("2");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Start simulation" }));
    await screen.findByText("Initial snapshot S1 found.");
    expect(dashApi.init).toHaveBeenLastCalledWith({
      mode: "simplified",
      sigScopes: { PID: 2 },
    });
    await user.click(screen.getByRole("button", { name: "Scopes · PID 2" }));
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "3" },
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("graph").textContent).toBe("Light/On");
    expect(dashApi.init).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Scopes · PID 2" }));
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "3" },
    });
    await user.click(screen.getByRole("button", { name: "Start simulation" }));
    await waitFor(() => expect(dashApi.init).toHaveBeenCalledTimes(2));
    expect(dashApi.init).toHaveBeenLastCalledWith({
      mode: "simplified",
      sigScopes: { PID: 3 },
    });
  });
});
describe("relation comparison", () => {
  it("ignores relation row order while preserving tuple column order", () => {
    expect(
      valuesChanged(
        [
          ["PID0", "0"],
          ["PID1", "1"],
        ],
        [
          ["PID1", "1"],
          ["PID0", "0"],
        ],
      ),
    ).toBe(false);
    expect(valuesChanged([["PID0", "0"]], [["0", "PID0"]])).toBe(true);
  });
  it("distinguishes absent, empty, false and zero", () => {
    expect(valuesChanged(undefined, [])).toBe(true);
    expect(valuesChanged([], ["0"])).toBe(true);
    expect(valuesChanged(["false"], ["0"])).toBe(true);
    expect(valuesChanged(["0"], ["0"])).toBe(false);
  });
});
