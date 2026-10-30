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
  StatechartGraph: ({
    activeStateIds,
    children,
  }: {
    activeStateIds: string[];
    children?: React.ReactNode;
  }) => (
    <div>
      <div data-testid="graph">{activeStateIds.join(",")}</div>
      {children}
    </div>
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
    staticInfo: vi.fn(),
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
  vars: [
    { id: "Light/value", kind: "INT", multiplicity: "one", type: "Int", params: [] },
  ],
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
  vi.mocked(dashApi.staticInfo).mockResolvedValue({
    ...meta,
    available: true,
    integers: { min: -8, max: 7, seqLength: 4 },
    modules: ["util/ordering [Floor]"],
    sigs: [
      {
        name: "Floor",
        modifiers: "",
        scope: 3,
        atoms: ["Floor_0", "Floor_1", "Floor_2"],
        fields: [],
      },
      {
        name: "Const",
        modifiers: "one",
        atoms: ["Const"],
        fields: [{ name: "limit", values: ["7"] }],
      },
    ],
    orderings: [
      { module: "ordering", sig: "Floor", order: ["Floor_2", "Floor_0", "Floor_1"] },
    ],
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
describe("static and dynamic panels", () => {
  it("shows the solver's static choices in the hierarchy view on request", async () => {
    const user = await openAndStart();
    expect(screen.queryByLabelText("Static model info")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Show static model info" }),
    );
    const info = await screen.findByLabelText("Static model info");
    await waitFor(() =>
      expect(within(info).getByText("Floor_2 < Floor_0 < Floor_1")).toBeTruthy(),
    );
    expect(within(info).getByText("Int -8 … 7 (4-bit)")).toBeTruthy();
    expect(within(info).getByText("Const.limit = 7")).toBeTruthy();
  });
  it("keeps transition definitions out of the snapshot info", async () => {
    const { user, region } = await stepAndOpenTrace();
    const takenRow = within(region).getByText("Transition taken").closest("tr")!;
    await user.click(takenRow.querySelectorAll("td")[1]);
    const kripke = screen.getByRole("complementary", {
      name: "Explored Kripke structure",
    });
    expect(within(kripke).getByText("Snapshot S2")).toBeTruthy();
    expect(within(kripke).queryByText("Guard")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Static Model Hierarchy" }),
    );
    const details = screen.getByRole("complementary", { name: "Model details" });
    const definition = within(details)
      .getByRole("heading", { name: "Transition" })
      .closest("section")!;
    expect(within(definition).getByText("Light/Toggle")).toBeTruthy();
  });
  it("overlays the current snapshot's variables on the Kripke panel", async () => {
    const user = await openAndStart();
    await user.click(screen.getByRole("button", { name: "Step →" }));
    await screen.findByText("Stepped to S2.");
    expect(screen.queryByLabelText("S2 overlay")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show variables" }));
    const overlay = screen.getByLabelText("S2 overlay");
    expect(within(overlay).getByText("value")).toBeTruthy();
    expect(within(overlay).getByText("1")).toBeTruthy();
  });
  it("marks changed cells only when highlighting is enabled", async () => {
    const { user, region } = await stepAndOpenTrace();
    const valueRow = within(region).getByText("value").closest("tr")!;
    expect(valueRow.querySelectorAll("td.changed")).toHaveLength(0);
    await user.click(screen.getByRole("checkbox", { name: "Highlight changes" }));
    expect(valueRow.querySelectorAll("td.changed")).toHaveLength(1);
  });
  it("shows model source without the read-only caption", async () => {
    vi.mocked(dashApi.source).mockResolvedValue({
      ...meta,
      dsh: "state Light {}",
      als: "sig Light {}",
      file: "test.dsh",
    });
    const user = await openAndStart();
    await user.click(screen.getByRole("button", { name: "Model Source" }));
    await screen.findByText("state Light {}");
    expect(screen.queryByText("Read-only model source")).toBeNull();
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
