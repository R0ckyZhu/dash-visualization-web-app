import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { StateTree } from "../state/stateTree";

function buildElements(
  tree: StateTree,
  edgeLabel: (transitionId: string) => string,
): ElementDefinition[] {
  const nodes = tree.nodes.map((node) => ({
    data: {
      id: `kn_${node.id}`,
      label: node.label,
      stateNodeId: node.id,
    },
    classes: node.snapshot.stable === false ? "unstable" : "stable",
  }));
  const edges = tree.edges.map((edge) => ({
    data: {
      id: `ke_${edge.id}`,
      source: `kn_${edge.source}`,
      target: `kn_${edge.target}`,
      sourceStateNodeId: edge.source,
      targetStateNodeId: edge.target,
      transition: edge.transition,
      label: edge.transition ? edgeLabel(edge.transition) : "",
    },
    classes: edge.source === edge.target ? "self-loop" : "",
  }));
  return [...nodes, ...edges];
}

export function KripkeGraph({
  currentNodeId,
  edgeLabel,
  isSelectedTransition,
  onSelectNode,
  onSelectTransition,
  pathNodeIds,
  selectedNodeId,
  tree,
}: {
  currentNodeId: number | null;
  edgeLabel: (transitionId: string) => string;
  isSelectedTransition: (transitionId: string) => boolean;
  onSelectNode: (nodeId: number) => void;
  onSelectTransition: (transitionId: string, targetNodeId: number) => void;
  pathNodeIds: number[];
  selectedNodeId: number | null;
  tree: StateTree;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectNodeRef = useRef(onSelectNode);
  const onSelectTransitionRef = useRef(onSelectTransition);
  const edgeLabelRef = useRef(edgeLabel);

  useEffect(() => {
    onSelectNodeRef.current = onSelectNode;
    onSelectTransitionRef.current = onSelectTransition;
    edgeLabelRef.current = edgeLabel;
  }, [edgeLabel, onSelectNode, onSelectTransition]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || tree.nodes.length === 0) return;
    const singleNode = tree.nodes.length === 1;
    const cy = cytoscape({
      container,
      elements: buildElements(tree, edgeLabelRef.current),
      minZoom: 0.15,
      maxZoom: 2,
      wheelSensitivity: 0.18,
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "text-valign": "center",
            "text-halign": "center",
            "background-color": "#2e7d32",
            color: "#fff",
            "font-size": 12,
            "font-weight": "bold",
            width: 52,
            height: 32,
            "border-color": "#43a047",
            "border-width": 2,
            shape: "roundrectangle",
            "z-index-compare": "manual",
            "z-index": 1,
          },
        },
        {
          selector: "node.unstable",
          style: {
            "background-color": "#755021",
            "border-color": "#f0bf63",
            shape: "triangle",
          },
        },
        {
          selector: "node.on-path",
          style: { "border-color": "#a5d8ff" },
        },
        {
          selector: "node.current",
          style: { "border-color": "#f2bd4a", "border-width": 4 },
        },
        {
          selector: "node.selected",
          style: {
            "border-color": "#ff8a65",
            "border-width": 4,
            "border-style": "double",
          },
        },
        {
          selector: "edge",
          style: {
            label: "data(label)",
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "arrow-scale": 1,
            "font-size": 11,
            "text-wrap": "wrap",
            color: "#cfd8dc",
            "text-background-color": "#0d1520",
            "text-background-opacity": 0.9,
            "text-background-padding": "2px",
            "line-color": "#546e7a",
            "target-arrow-color": "#546e7a",
            width: 1.5,
            // Edges and their labels draw above nodes, so the label of a short
            // edge between neighbouring snapshots is not hidden behind them.
            "z-index-compare": "manual",
            "z-index": 5,
          },
        },
        {
          selector: "edge.self-loop",
          style: {
            // Loop out to the right, clear of the edges entering from above.
            "loop-direction": "90deg",
            "loop-sweep": "-50deg",
            "control-point-step-size": 56,
            "text-margin-x": 34,
          },
        },
        {
          selector: "edge.on-path",
          style: {
            "line-color": "#6ab7ff",
            "target-arrow-color": "#6ab7ff",
            width: 2.5,
          },
        },
        {
          selector: "edge.selected",
          style: {
            "line-color": "#ff8a65",
            "target-arrow-color": "#ff8a65",
            color: "#ffccbc",
            width: 3,
          },
        },
      ],
      layout: singleNode
        ? { name: "preset" }
        : {
            name: "breadthfirst",
            directed: true,
            roots: ["kn_1"],
            animate: false,
            avoidOverlap: true,
            spacingFactor: 1.75,
            padding: 24,
          },
    });

    let frame: number | null = null;
    const fitGraph = () => {
      frame = null;
      if (cy.destroyed()) return;
      cy.resize();
      if (singleNode) {
        cy.getElementById("kn_1").position({
          x: container.clientWidth / 2,
          y: container.clientHeight / 2,
        });
        cy.zoom(1);
        cy.pan({ x: 0, y: 0 });
      } else {
        cy.fit(undefined, 24);
        if (cy.zoom() > 1) {
          cy.zoom(1);
          cy.center();
        }
      }
    };
    const scheduleFit = () => {
      if (frame == null) frame = requestAnimationFrame(fitGraph);
    };

    cy.on("tap", "node", (event) =>
      onSelectNodeRef.current(event.target.data("stateNodeId")),
    );
    cy.on("tap", "edge", (event) => {
      const target = event.target.data("targetStateNodeId") as number;
      const transition = event.target.data("transition") as string;
      if (transition) onSelectTransitionRef.current(transition, target);
      else onSelectNodeRef.current(target);
    });
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(container);
    scheduleFit();
    cyRef.current = cy;

    return () => {
      observer.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
      cy.destroy();
      cyRef.current = null;
    };
  }, [tree]);

  // Highlight the current path, the cursor and the selection without a re-layout.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const pathSteps = new Set(
      pathNodeIds.slice(1).map((id, index) => `${pathNodeIds[index]}:${id}`),
    );
    const pathNodes = new Set(pathNodeIds);
    cy.batch(() => {
      cy.elements().removeClass("on-path current selected");
      cy.nodes().forEach((node) => {
        const id = node.data("stateNodeId") as number;
        if (pathNodes.has(id)) node.addClass("on-path");
        if (id === currentNodeId) node.addClass("current");
        if (id === selectedNodeId) node.addClass("selected");
      });
      cy.edges().forEach((edge) => {
        const step = `${edge.data("sourceStateNodeId")}:${edge.data("targetStateNodeId")}`;
        if (pathSteps.has(step)) edge.addClass("on-path");
        const transition = edge.data("transition") as string;
        if (transition && isSelectedTransition(transition))
          edge.addClass("selected");
      });
    });
  }, [currentNodeId, isSelectedTransition, pathNodeIds, selectedNodeId, tree]);

  if (tree.nodes.length === 0) {
    return (
      <div className="state-tree-empty">
        Start a simulation to explore the first snapshot.
      </div>
    );
  }

  return (
    <div className="state-tree-graph-shell">
      <div
        aria-label="Explored Kripke structure"
        className="state-tree-canvas"
        ref={containerRef}
      />
    </div>
  );
}
