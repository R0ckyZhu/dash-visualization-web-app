import { useEffect, useRef, useState } from "react";
import cytoscape, { type Core, type ElementDefinition, type NodeSingular } from "cytoscape";
import type { DashEvent, DashModel, DashState, DashTransition, DashVar } from "../api/types";
import {
  activeEventSets,
  formatSnapshotValues,
  normalizeSnapshotAtom,
  snapshotVariableValues
} from "../state/snapshotData";

const ZOOM_STEP = 1.5;
const ZOOM_HOLD_STEP = 1.12;
const ZOOM_HOLD_DELAY = 280;
const ZOOM_HOLD_INTERVAL = 60;

const LEAF_WIDTH = 110;
const LEAF_HEIGHT = 45;
const COMPOUND_PADDING = 40;
const HORIZONTAL_GAP = 60;
const VERTICAL_GAP = 140;
const PARALLEL_EDGE_GAP = 44;
const PARALLEL_LABEL_GAP = 24;

export type StatechartSelection =
  | { kind: "state"; value: DashState }
  | { kind: "transition"; value: DashTransition };
export type StatechartOverlayMode = "events" | "variables" | null;

interface EventOverlayGroup {
  id: string;
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
  events: Array<{ event: DashEvent; active: boolean }>;
}

interface VariableOverlayGroup {
  id: string;
  label: string;
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
  variables: Array<{ variable: DashVar; value: string }>;
}

function shortName(id: string) {
  return id.split("/").pop() ?? id;
}

function stateLabel(state: DashState) {
  const originalLabel = shortName(state._originalId ?? state.id);
  return state._isParamRoot && state._paramInstance
    ? `${originalLabel}[${state._paramInstance}]`
    : originalLabel;
}

function stateClass(state: DashState) {
  if (state.kind !== "BASIC" && state.kind === "AND") return "compound-and";
  if (state.kind !== "BASIC" && state.kind === "OR") return "compound-or";
  return state.isDefault ? "default-state" : "state";
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true });
}

function buildElements(model: DashModel): ElementDefinition[] {
  const stateIds = new Set(model.states.map((state) => state.id));
  const nodes = [...model.states]
    .sort((left, right) => naturalCompare(left.id, right.id))
    .map((state) => ({
      data: {
        id: state.id,
        label: stateLabel(state),
        parent: state.parent ?? undefined,
        fullData: state
      },
      classes: stateClass(state)
    }));

  const transitions = [...model.transitions]
    .filter((transition) => transition.from && transition.to)
    .filter(
      (transition) =>
        stateIds.has(transition.from as string) && stateIds.has(transition.to as string)
    )
    .sort((left, right) => naturalCompare(left.id, right.id));
  const pairGroups = new Map<string, DashTransition[]>();
  for (const transition of transitions) {
    const source = transition.from as string;
    const target = transition.to as string;
    const pair = [source, target].sort(naturalCompare).join("\u0000");
    pairGroups.set(pair, [...(pairGroups.get(pair) ?? []), transition]);
  }

  const controlPointDistances = new Map<string, number>();
  const labelMargins = new Map<string, number>();
  pairGroups.forEach((group) => {
    group.forEach((transition, index) => {
      const source = transition.from as string;
      const target = transition.to as string;
      const centeredIndex = index - (group.length - 1) / 2;
      const canonicalDirection = naturalCompare(source, target) <= 0 ? 1 : -1;
      controlPointDistances.set(
        transition.id,
        centeredIndex * PARALLEL_EDGE_GAP * canonicalDirection
      );
      labelMargins.set(transition.id, centeredIndex * PARALLEL_LABEL_GAP);
    });
  });

  const edges = transitions.map((transition) => ({
    data: {
      id: `edge_${transition.id}`,
      source: transition.from as string,
      target: transition.to as string,
      label: shortName(transition._originalId ?? transition.id),
      controlPointDistance: controlPointDistances.get(transition.id) ?? 0,
      controlPointWeight: 0.5,
      labelMarginY: labelMargins.get(transition.id) ?? 0,
      transitionId: transition.id,
      fullData: transition
    }
  }));

  return [...nodes, ...edges];
}

function sortNodes(nodes: NodeSingular[]) {
  return nodes.sort((left, right) =>
    naturalCompare(left.data("label") || left.id(), right.data("label") || right.id())
  );
}

function deterministicLayout(cy: Core, overlayRows: Map<string, number> = new Map()) {
  function reservedHeight(node: NodeSingular) {
    const fullData = node.data("fullData") as DashState | undefined;
    const ownerId = fullData?._originalId ?? node.id();
    return (overlayRows.get(ownerId) ?? 0) * 24;
  }

  function layoutNode(node: NodeSingular, originX: number, originY: number) {
    const children = node.children().toArray();
    if (children.length === 0) {
      node.position({ x: originX + LEAF_WIDTH / 2, y: originY + LEAF_HEIGHT / 2 });
      return { width: LEAF_WIDTH, height: LEAF_HEIGHT };
    }

    const compounds = sortNodes(children.filter((child) => child.isParent()));
    const leaves = children.filter((child) => !child.isParent()).sort((left, right) => {
      const defaultOrder =
        Number(!left.hasClass("default-state")) - Number(!right.hasClass("default-state"));
      return (
        defaultOrder ||
        naturalCompare(left.data("label") || left.id(), right.data("label") || right.id())
      );
    });
    const defaults = leaves.filter((leaf) => leaf.hasClass("default-state"));
    const nonDefaults = leaves.filter((leaf) => !leaf.hasClass("default-state"));
    const innerX = originX + COMPOUND_PADDING;
    let cursorY = originY + COMPOUND_PADDING + 20 + reservedHeight(node);
    let maxWidth = 0;

    if (defaults.length > 0) {
      let cursorX = innerX;
      for (const leaf of defaults) {
        leaf.position({ x: cursorX + LEAF_WIDTH / 2, y: cursorY + LEAF_HEIGHT / 2 });
        cursorX += LEAF_WIDTH + HORIZONTAL_GAP;
      }
      maxWidth = Math.max(maxWidth, cursorX - innerX - HORIZONTAL_GAP);
      cursorY += LEAF_HEIGHT + VERTICAL_GAP;
    }

    if (compounds.length > 0) {
      let cursorX = innerX;
      let rowHeight = 0;
      for (const compound of compounds) {
        const size = layoutNode(compound, cursorX, cursorY);
        cursorX += size.width + HORIZONTAL_GAP;
        rowHeight = Math.max(rowHeight, size.height);
      }
      maxWidth = Math.max(maxWidth, cursorX - innerX - HORIZONTAL_GAP);
      cursorY += rowHeight + VERTICAL_GAP;
    }

    if (nonDefaults.length > 0) {
      const columns = Math.max(2, Math.ceil(maxWidth / (LEAF_WIDTH + HORIZONTAL_GAP)));
      let cursorX = innerX;
      let column = 0;
      for (const leaf of nonDefaults) {
        leaf.position({ x: cursorX + LEAF_WIDTH / 2, y: cursorY + LEAF_HEIGHT / 2 });
        cursorX += LEAF_WIDTH + HORIZONTAL_GAP;
        column += 1;
        if (column >= columns) {
          column = 0;
          cursorX = innerX;
          cursorY += LEAF_HEIGHT + VERTICAL_GAP;
        }
      }
      const rowWidth =
        Math.min(nonDefaults.length, columns) * (LEAF_WIDTH + HORIZONTAL_GAP) -
        HORIZONTAL_GAP;
      maxWidth = Math.max(maxWidth, rowWidth);
      cursorY += LEAF_HEIGHT;
    }

    return {
      width: maxWidth + COMPOUND_PADDING * 2,
      height: cursorY - originY + COMPOUND_PADDING
    };
  }

  const roots = sortNodes(
    cy
      .nodes()
      .filter((node) => node.isParent() && !node.data("parent"))
      .toArray() as NodeSingular[]
  );
  const orphanLeaves = sortNodes(
    cy
      .nodes()
      .filter((node) => !node.isParent() && !node.data("parent"))
      .toArray() as NodeSingular[]
  );
  let originX = 0;

  for (const root of roots) {
    const size = layoutNode(root, originX, 0);
    originX += size.width + HORIZONTAL_GAP * 2;
  }
  orphanLeaves.forEach((leaf, index) => {
    leaf.position({
      x: originX + LEAF_WIDTH / 2,
      y: index * (LEAF_HEIGHT + VERTICAL_GAP) + LEAF_HEIGHT / 2
    });
  });
}

/** Where the deterministic layout last placed each leaf, so manual drags can be
    measured as an offset from it and re-applied after a re-layout. */
function captureLayoutPositions(cy: Core) {
  const positions = new Map<string, { x: number; y: number }>();
  cy.nodes().forEach((node) => {
    if (node.isParent()) return;
    const position = node.position();
    positions.set(node.id(), { x: position.x, y: position.y });
  });
  return positions;
}

function overlayRowsFor(model: DashModel, mode: "events" | "variables" | null) {
  const rows = new Map<string, number>();
  const items = mode === "events" ? model.events : mode === "variables" ? model.vars : [];
  for (const item of items) {
    const ownerId = item.id.split("/").slice(0, -1).join("/");
    rows.set(ownerId, (rows.get(ownerId) ?? 0) + 1);
  }
  if (mode === "variables") {
    rows.forEach((count, ownerId) => rows.set(ownerId, Math.ceil(count / 2)));
  }
  return rows;
}

function applyOverlayPadding(cy: Core, overlayRows: Map<string, number>) {
  cy.nodes().forEach((node) => {
    if (!node.hasClass("compound-and") && !node.hasClass("compound-or")) return;
    const fullData = node.data("fullData") as DashState | undefined;
    const ownerId = fullData?._originalId ?? node.id();
    const rows = node.isParent() ? (overlayRows.get(ownerId) ?? 0) : 0;
    node.style("padding", `${20 + rows * 24}px`);
  });
}

export function StatechartGraph({
  activeStateIds,
  currentSnapshotRaw,
  hasSnapshot,
  model,
  onOverlayModeChange,
  onSelectionChange,
  overlayMode,
  selection,
  takenTransitionIds
}: {
  activeStateIds: string[];
  currentSnapshotRaw: Record<string, unknown> | null;
  hasSnapshot: boolean;
  model: DashModel;
  onOverlayModeChange: (mode: StatechartOverlayMode) => void;
  onSelectionChange: (selection: StatechartSelection | null) => void;
  overlayMode: StatechartOverlayMode;
  selection: StatechartSelection | null;
  takenTransitionIds: string[];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const overlayFrameRef = useRef<number | null>(null);
  const zoomHoldRef = useRef<{ delay: number; repeat: number | null } | null>(null);
  const pointerZoomRef = useRef(false);
  const layoutPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const renderOverlaysRef = useRef<() => void>(() => undefined);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const [eventOverlayGroups, setEventOverlayGroups] = useState<EventOverlayGroup[]>([]);
  const [variableOverlayGroups, setVariableOverlayGroups] = useState<VariableOverlayGroup[]>([]);
  const eventsVisible = overlayMode === "events";
  const variablesVisible = overlayMode === "variables";

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    return () => {
      if (zoomHoldRef.current == null) return;
      window.clearTimeout(zoomHoldRef.current.delay);
      if (zoomHoldRef.current.repeat != null) window.clearInterval(zoomHoldRef.current.repeat);
      zoomHoldRef.current = null;
    };
  }, []);

  renderOverlaysRef.current = () => {
    const cy = cyRef.current;
    if (!cy) {
      setEventOverlayGroups([]);
      setVariableOverlayGroups([]);
      return;
    }

    if (eventsVisible) {
      const { bare, tuples } = activeEventSets(currentSnapshotRaw);
      const groups = new Map<string, EventOverlayGroup>();
      for (const event of model.events) {
        const ownerId = event.id.split("/").slice(0, -1).join("/");
        const atom = normalizeSnapshotAtom(event.id.replace(/\//g, "_"));
        const parameterized = (event.params?.length ?? 0) > 0;
        const targets = cy.nodes().filter((node) => {
          const fullData = node.data("fullData") as DashState | undefined;
          return node.id() === ownerId || fullData?._originalId === ownerId;
        });

        targets.forEach((node) => {
          const fullData = node.data("fullData") as DashState | undefined;
          const instance = fullData?._paramInstance;
          const active = parameterized
            ? instance != null && tuples.has(`${normalizeSnapshotAtom(instance)}->${atom}`)
            : bare.has(atom);
          const box = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
          const inset = 7;
          const id = node.id();
          const group = groups.get(id) ?? {
            id,
            left: box.x1 + inset,
            top: box.y1 + inset,
            maxWidth: Math.max(0, box.w - inset * 2),
            maxHeight: Math.max(0, box.h - inset * 2),
            events: []
          };
          group.events.push({ event, active });
          groups.set(id, group);
        });
      }
      setEventOverlayGroups([...groups.values()]);
    } else {
      setEventOverlayGroups([]);
    }

    if (variablesVisible) {
      const groups = new Map<string, VariableOverlayGroup>();
      for (const variable of model.vars) {
        const ownerId = variable.id.split("/").slice(0, -1).join("/");
        const parameterized = (variable.params?.length ?? 0) > 0;
        const targets = cy.nodes().filter((node) => {
          const fullData = node.data("fullData") as DashState | undefined;
          return node.id() === ownerId || fullData?._originalId === ownerId;
        });

        targets.forEach((node) => {
          const fullData = node.data("fullData") as DashState | undefined;
          const instance = parameterized ? fullData?._paramInstance : undefined;
          const values = snapshotVariableValues(currentSnapshotRaw, variable.id, instance);
          const box = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
          const inset = 7;
          const id = node.id();
          const group = groups.get(id) ?? {
            id,
            label: node.data("label") || id,
            left: box.x1 + inset,
            top: box.y1 + inset,
            maxWidth: Math.max(0, box.w - inset * 2),
            maxHeight: Math.max(0, box.h - inset * 2),
            variables: [] as VariableOverlayGroup["variables"]
          };
          group.variables.push({
            variable,
            value: currentSnapshotRaw ? formatSnapshotValues(values) : "—"
          });
          groups.set(id, group);
        });
      }
      setVariableOverlayGroups([...groups.values()]);
    } else {
      setVariableOverlayGroups([]);
    }
  };

  function scheduleEventOverlay() {
    if (overlayFrameRef.current != null) return;
    overlayFrameRef.current = requestAnimationFrame(() => {
      overlayFrameRef.current = null;
      renderOverlaysRef.current();
    });
  }

  function fitGraph() {
    cyRef.current?.fit(undefined, 30);
  }

  /** Zoom about the middle of the viewport, so the graph grows in place
      instead of drifting toward the canvas origin. */
  function zoomGraph(factor: number) {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom({
      level: cy.zoom() * factor,
      renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 }
    });
  }

  /**
   * Overlay chips need reserved height inside each compound, so toggling them has
   * to re-run the layout. Keep the user's work across it: remember pan and zoom,
   * and re-apply however far each node was dragged from its last laid-out spot.
   */
  function relayoutPreservingView(cy: Core, overlayRows: Map<string, number>) {
    const pan = { ...cy.pan() };
    const zoom = cy.zoom();
    const drags = new Map<string, { dx: number; dy: number }>();

    cy.nodes().forEach((node) => {
      if (node.isParent()) return;
      const previous = layoutPositionsRef.current.get(node.id());
      if (!previous) return;
      const current = node.position();
      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      if (dx !== 0 || dy !== 0) drags.set(node.id(), { dx, dy });
    });

    deterministicLayout(cy, overlayRows);
    layoutPositionsRef.current = captureLayoutPositions(cy);

    cy.nodes().forEach((node) => {
      const drag = drags.get(node.id());
      if (!drag) return;
      const position = node.position();
      node.position({ x: position.x + drag.dx, y: position.y + drag.dy });
    });

    cy.zoom(zoom);
    cy.pan(pan);
  }

  function stopZoomHold() {
    if (zoomHoldRef.current == null) return;
    window.clearTimeout(zoomHoldRef.current.delay);
    if (zoomHoldRef.current.repeat != null) window.clearInterval(zoomHoldRef.current.repeat);
    zoomHoldRef.current = null;
  }

  /** One step on press, then continuous smaller steps while the button is held. */
  function startZoomHold(direction: 1 | -1) {
    pointerZoomRef.current = true;
    stopZoomHold();
    zoomGraph(direction === 1 ? ZOOM_STEP : 1 / ZOOM_STEP);

    const delay = window.setTimeout(() => {
      const repeat = window.setInterval(
        () => zoomGraph(direction === 1 ? ZOOM_HOLD_STEP : 1 / ZOOM_HOLD_STEP),
        ZOOM_HOLD_INTERVAL
      );
      if (zoomHoldRef.current) zoomHoldRef.current.repeat = repeat;
      else window.clearInterval(repeat);
    }, ZOOM_HOLD_DELAY);

    zoomHoldRef.current = { delay, repeat: null };
  }

  /** Keyboard activation still needs to work; a pointer press already zoomed. */
  function zoomFromClick(direction: 1 | -1) {
    if (pointerZoomRef.current) {
      pointerZoomRef.current = false;
      return;
    }
    zoomGraph(direction === 1 ? ZOOM_STEP : 1 / ZOOM_STEP);
  }

  function exportGraph() {
    const cy = cyRef.current;
    if (!cy) return;
    const anchor = document.createElement("a");
    anchor.href = cy.png({ full: true, scale: 2, bg: "#0f1923" });
    anchor.download = `${model.rootName || "statechart"}.png`;
    anchor.click();
  }

  useEffect(() => {
    if (!containerRef.current) return;
    setEventOverlayGroups([]);
    setVariableOverlayGroups([]);

    const cy = cytoscape({
      container: containerRef.current,
      elements: buildElements(model),
      minZoom: 0.08,
      maxZoom: 3,
      wheelSensitivity: 0.5,
      style: [
        {
          selector: "node.compound-and",
          style: {
            "background-color": "#1e3a5f",
            "background-opacity": 0.5,
            "border-width": 2,
            "border-color": "#4fc3f7",
            label: "data(label)",
            "text-valign": "top",
            "text-halign": "center",
            color: "#4fc3f7",
            "font-size": 16,
            "font-weight": "bold"
          }
        },
        {
          selector: "node.compound-or",
          style: {
            "background-color": "#162447",
            "background-opacity": 0.4,
            "border-width": 2,
            "border-style": "dashed",
            "border-color": "#7986cb",
            label: "data(label)",
            "text-valign": "top",
            "text-halign": "center",
            color: "#7986cb",
            "font-size": 14,
            padding: "20px",
            shape: "roundrectangle",
            "text-margin-y": -5
          }
        },
        {
          selector: "node.compound-and:childless, node.compound-or:childless",
          style: { width: 260, height: 170 }
        },
        {
          selector: "node.state",
          style: {
            "background-color": "#2e7d32",
            label: "data(label)",
            "text-valign": "center",
            "text-halign": "center",
            color: "#fff",
            "font-size": 13,
            width: 80,
            height: 40,
            "border-width": 2,
            "border-color": "#43a047",
            shape: "roundrectangle"
          }
        },
        {
          selector: "node.default-state",
          style: {
            "background-color": "#f9a825",
            label: "data(label)",
            "text-valign": "center",
            "text-halign": "center",
            color: "#333",
            "font-size": 13,
            "font-weight": "bold",
            width: 80,
            height: 40,
            "border-width": 3,
            "border-color": "#f57f17",
            shape: "roundrectangle"
          }
        },
        {
          selector: "node.selected-node",
          style: { "border-color": "#ff5722", "border-width": 4 }
        },
        {
          selector: "node.trace-active",
          style: { "border-color": "#00e676", "border-width": 4 }
        },
        { selector: "node.trace-inactive", style: { opacity: 0.4 } },
        {
          selector: "edge",
          style: {
            label: "data(label)",
            "curve-style": "unbundled-bezier",
            "control-point-distances": "data(controlPointDistance)",
            "control-point-weights": "data(controlPointWeight)",
            "target-arrow-shape": "triangle",
            "arrow-scale": 1.2,
            "font-size": 12,
            color: "#e0e0e0",
            "text-background-color": "#0f1923",
            "text-background-opacity": 0.9,
            "text-background-padding": "4px",
            "text-background-shape": "roundrectangle",
            "text-margin-y": 0,
            "line-color": "#78909c",
            "target-arrow-color": "#78909c",
            width: 2
          }
        },
        {
          selector: "edge.trace-taken",
          style: {
            "line-color": "#00e676",
            "target-arrow-color": "#00e676",
            width: 3,
            color: "#00e676"
          }
        },
        { selector: "edge.trace-inactive", style: { opacity: 0.5 } },
        {
          selector: "edge.selected-edge",
          style: { "line-color": "#ff5722", "target-arrow-color": "#ff5722", width: 3 }
        }
      ],
      layout: { name: "preset" }
    });

    cy.edges().forEach((edge) => {
      edge.style("text-margin-y", edge.data("labelMarginY") as number);
    });
    deterministicLayout(cy);
    layoutPositionsRef.current = captureLayoutPositions(cy);
    cy.fit(undefined, 30);

    cy.on("tap", "node", (event) => {
      onSelectionChangeRef.current({
        kind: "state",
        value: event.target.data("fullData") as DashState
      });
    });
    cy.on("tap", "edge", (event) => {
      onSelectionChangeRef.current({
        kind: "transition",
        value: event.target.data("fullData") as DashTransition
      });
    });
    cy.on("tap", (event) => {
      if (event.target === cy) onSelectionChangeRef.current(null);
    });

    cy.on("drag", "node", (event) => {
      const node = event.target;
      if (node.isParent()) return;
      const ancestors = node.ancestors();
      const forbidden = cy.nodes().filter((candidate) => candidate.isParent() && !ancestors.contains(candidate));
      const position = node.position();
      const halfWidth = node.outerWidth() / 2;
      const halfHeight = node.outerHeight() / 2;
      let x = position.x;
      let y = position.y;

      forbidden.forEach((candidate) => {
        const box = candidate.boundingBox({ includeLabels: false, includeOverlays: false });
        const left = box.x1 - 8;
        const right = box.x2 + 8;
        const top = box.y1 - 8;
        const bottom = box.y2 + 8;
        if (x + halfWidth <= left || x - halfWidth >= right || y + halfHeight <= top || y - halfHeight >= bottom) return;
        const shifts = [
          { axis: "x", value: left - (x + halfWidth) },
          { axis: "x", value: right - (x - halfWidth) },
          { axis: "y", value: top - (y + halfHeight) },
          { axis: "y", value: bottom - (y - halfHeight) }
        ].sort((first, second) => Math.abs(first.value) - Math.abs(second.value));
        if (shifts[0].axis === "x") x += shifts[0].value;
        else y += shifts[0].value;
      });
      if (x !== position.x || y !== position.y) node.position({ x, y });
    });

    cy.on("pan zoom resize", scheduleEventOverlay);
    cy.on("drag free", "node", scheduleEventOverlay);

    const observer = new ResizeObserver(() => {
      cy.resize();
      scheduleEventOverlay();
    });
    observer.observe(containerRef.current);
    cyRef.current = cy;
    return () => {
      observer.disconnect();
      if (overlayFrameRef.current != null) {
        cancelAnimationFrame(overlayFrameRef.current);
        overlayFrameRef.current = null;
      }
      cy.destroy();
      cyRef.current = null;
    };
  }, [model]);

  useEffect(() => {
    scheduleEventOverlay();
  }, [currentSnapshotRaw, eventsVisible, model, variablesVisible]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const mode = variablesVisible ? "variables" : eventsVisible ? "events" : null;
    const overlayRows = overlayRowsFor(model, mode);
    applyOverlayPadding(cy, overlayRows);
    relayoutPreservingView(cy, overlayRows);
    scheduleEventOverlay();
  }, [eventsVisible, model, variablesVisible]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const activeStates = new Set(activeStateIds);
    const takenTransitions = new Set(takenTransitionIds);

    cy.batch(() => {
      cy.nodes().removeClass("trace-active trace-inactive");
      cy.edges().removeClass("trace-taken trace-inactive");
      if (!hasSnapshot) return;

      cy.nodes().filter((node) => !node.isParent()).addClass("trace-inactive");
      cy.edges().addClass("trace-inactive");
      for (const stateId of activeStates) {
        cy.getElementById(stateId).removeClass("trace-inactive").addClass("trace-active");
      }
      for (const transitionId of takenTransitions) {
        cy.getElementById(`edge_${transitionId}`).removeClass("trace-inactive").addClass("trace-taken");
      }
    });
  }, [activeStateIds, hasSnapshot, model, takenTransitionIds]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("selected-node selected-edge");
    if (selection?.kind === "state") {
      cy.getElementById(selection.value.id).addClass("selected-node");
    } else if (selection?.kind === "transition") {
      cy.getElementById(`edge_${selection.value.id}`).addClass("selected-edge");
    }
  }, [model, selection]);

  return (
    <div className="statechart-component">
      <div className="graph-controls" aria-label="Statechart controls">
        <button onClick={fitGraph} type="button">Fit</button>
        <button
          aria-label="Zoom in"
          onClick={() => zoomFromClick(1)}
          onPointerCancel={stopZoomHold}
          onPointerDown={() => startZoomHold(1)}
          onPointerLeave={stopZoomHold}
          onPointerUp={stopZoomHold}
          title="Zoom in (hold to keep zooming)"
          type="button"
        >
          +
        </button>
        <button
          aria-label="Zoom out"
          onClick={() => zoomFromClick(-1)}
          onPointerCancel={stopZoomHold}
          onPointerDown={() => startZoomHold(-1)}
          onPointerLeave={stopZoomHold}
          onPointerUp={stopZoomHold}
          title="Zoom out (hold to keep zooming)"
          type="button"
        >
          -
        </button>
        <button onClick={exportGraph} type="button">PNG</button>
        <div className="overlay-controls" aria-label="Statechart data overlays">
          <button
            className={eventsVisible ? "toggle-on" : ""}
            disabled={model.events.length === 0}
            onClick={() => onOverlayModeChange(eventsVisible ? null : "events")}
            type="button"
          >
            Events
          </button>
          <button
            className={variablesVisible ? "toggle-on" : ""}
            disabled={model.vars.length === 0}
            onClick={() => onOverlayModeChange(variablesVisible ? null : "variables")}
            type="button"
          >
            Variables
          </button>
        </div>
      </div>
      <div className="statechart-graph-shell">
        <div className="statechart-canvas" ref={containerRef} />
        <div className="event-overlay">
          {eventOverlayGroups.map((group) => (
            <div
              className="event-group"
              key={group.id}
              style={{
                left: group.left,
                top: group.top,
                maxHeight: group.maxHeight,
                maxWidth: group.maxWidth
              }}
            >
              {group.events.map(({ event, active }) => (
                <div className={`event-chip ${active ? "active" : "inactive"}`} key={event.id} title={event.id}>
                  <span className="event-dot" />
                  <span>{shortName(event.id)}</span>
                  <small>{event.kind}</small>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="variable-overlay">
          {variableOverlayGroups.map((group) => (
            <div
              aria-label={`${group.label} variables`}
              className="variable-group"
              key={group.id}
              style={{
                left: group.left,
                top: group.top,
                maxHeight: group.maxHeight,
                maxWidth: group.maxWidth
              }}
            >
              {group.variables.map(({ variable, value }) => (
                <div
                  className="variable-chip"
                  key={variable.id}
                  title={`${variable.id} = ${value} (${variable.type ?? "?"})`}
                >
                  <span className="variable-name">{shortName(variable.id)}</span>
                  <span className="variable-value">{value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
