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
vi.mock("../src/graph/StateTreeGraph", () => ({
  StateTreeGraph: () => <div>Tree canvas</div>,
}));
vi.mock("../src/api/dashApi", () => ({
  dashApi: {
    examples: vi.fn(),
    session: vi.fn(),
    llmCapabilities: vi.fn(),
    inspect: vi.fn(),
    init: vi.fn(),
    step: vi.fn(),
    generated: vi.fn(),
    updateUiContext: vi.fn(),
    nextInitSolution: vi.fn(),
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
  vi.mocked(dashApi.examples).mockResolvedValue([
    { name: "Test light", path: "test.dsh", group: "Examples" },
  ]);
  vi.mocked(dashApi.session).mockResolvedValue({
    ...meta,
    modelLoaded: false,
    lastOperation: null,
  });
  vi.mocked(dashApi.llmCapabilities).mockResolvedValue({
    enabled: false,
    provider: "none",
    model: null,
    streaming: false,
    readOnly: true,
    tools: [],
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
  vi.mocked(dashApi.generated).mockResolvedValue({ ...meta, available: false });
  vi.mocked(dashApi.updateUiContext).mockResolvedValue(meta);
});
async function openAndStart() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /Test light/ }));
  await user.click(
    await screen.findByRole("button", { name: "Start simulation" }),
  );
  await screen.findByText("Initial state S1 found.");
  return user;
}
describe("scope editor", () => {
  it("keeps changes local until Apply and submits exact edited values", async () => {
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
    await user.click(screen.getByRole("button", { name: "Apply and start" }));
    expect(apply).toHaveBeenCalledExactlyOnceWith({ PID: 3 }, true);
  });
  it("Cancel never commits and invalid values cannot apply", async () => {
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
      (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });
});
describe("simulation request integrity", () => {
  it("opens without solving, then forwards the selected mode and scopes", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Test light/ }));
    await screen.findByRole("button", { name: "Start simulation" });
    expect(dashApi.init).not.toHaveBeenCalled();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Mode" }),
      "raw",
    );
    await user.click(screen.getByRole("button", { name: "Start simulation" }));
    await waitFor(() =>
      expect(dashApi.init).toHaveBeenCalledExactlyOnceWith({
        mode: "raw",
        constraints: [],
        sigScopes: {},
      }),
    );
  });
  it("steps from selected raw snapshot and selecting history changes next Step origin", async () => {
    const user = await openAndStart();
    await user.click(screen.getByRole("button", { name: "Step →" }));
    await screen.findByText("Stepped to S2.");
    expect(dashApi.step).toHaveBeenLastCalledWith({
      state: first,
      mode: "simplified",
      constraints: [],
      sigScopes: {},
    });
    expect(screen.getByTestId("graph").textContent).toBe("Light/Off");
    await user.click(
      screen.getByRole("button", { name: "Events & Variables" }),
    );
    const region = screen.getByRole("region", {
      name: "Transitions and configuration",
    });
    await user.click(within(region).getByRole("button", { name: "S1" }));
    await user.click(screen.getByRole("button", { name: "Step →" }));
    await waitFor(() => expect(dashApi.step).toHaveBeenCalledTimes(2));
    expect(dashApi.step).toHaveBeenLastCalledWith({
      state: first,
      mode: "simplified",
      constraints: [],
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
  it("Cancel scopes preserves run; Apply and start uses fresh scope payload", async () => {
    vi.mocked(dashApi.inspect).mockResolvedValue({
      ...meta,
      model,
      scopeSigs: ["PID"],
      commandCount: 1,
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Test light/ }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Start simulation" }));
    await screen.findByText("Initial state S1 found.");
    await user.click(
      screen.getByRole("button", {
        name: "Configure",
        exact: true,
        expanded: false,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Edit scopes" }));
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "3" },
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("graph").textContent).toBe("Light/On");
    expect(dashApi.init).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Edit scopes" }));
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe(
      "1",
    );
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "2" },
    });
    await user.click(screen.getByRole("button", { name: "Apply and start" }));
    await waitFor(() => expect(dashApi.init).toHaveBeenCalledTimes(2));
    expect(dashApi.init).toHaveBeenLastCalledWith({
      mode: "simplified",
      constraints: [],
      sigScopes: { PID: 2 },
    });
  });
  it("saving/toggling constraints preserves snapshots and changes only future solve payload", async () => {
    const user = await openAndStart();
    await user.click(
      screen.getByRole("button", {
        name: "Configure",
        exact: true,
        expanded: false,
      }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Alloy predicates" }),
      "some none",
    );
    await user.click(screen.getByRole("button", { name: "Save constraints" }));
    expect(screen.getByTestId("graph").textContent).toBe("Light/On");
    await user.click(screen.getByRole("button", { name: "Step →" }));
    await waitFor(() => expect(dashApi.step).toHaveBeenCalledOnce());
    expect(dashApi.step).toHaveBeenLastCalledWith({
      state: first,
      mode: "simplified",
      constraints: ["some none"],
      sigScopes: {},
    });
    await user.click(
      screen.getByRole("switch", { name: "Constraints enabled" }),
    );
    await user.click(screen.getByRole("button", { name: "Step →" }));
    await waitFor(() => expect(dashApi.step).toHaveBeenCalledTimes(2));
    expect(vi.mocked(dashApi.step).mock.calls[1][0].constraints).toEqual([]);
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
