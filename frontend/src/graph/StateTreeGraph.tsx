import { useEffect, useRef } from "react";
import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import type { StateTree } from "../state/stateTree";

function shortName(id: string) {
  return id.split("/").pop() ?? id;
}

function buildElements(tree: StateTree): ElementDefinition[] {
  const nodes = tree.nodes.map((node) => ({
    data: {
      id: `tn_${node.id}`,
      label: node.label,
      stateNodeId: node.id
    },
    classes: `${node.snapshot.stable === false ? "unstable" : "stable"}${
      node.snapshot.terminal ? " terminal" : ""
    }`
  }));
  const edges = tree.edges.map((edge) => ({
    data: {
      id: `te_${edge.id}`,
      source: `tn_${edge.source}`,
      target: `tn_${edge.target}`,
      targetStateNodeId: edge.target,
      transition: edge.transition,
      label: edge.transition ? shortName(edge.transition) : ""
    }
  }));
  return [...nodes, ...edges];
}

export function StateTreeGraph({
  currentNodeId,
  onSelectNode,
  onSelectTransition,
  tree
}: {
  currentNodeId: number | null;
  onSelectNode: (nodeId: number) => void;
  onSelectTransition: (transitionId: string) => void;
  tree: StateTree;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectNodeRef = useRef(onSelectNode);
  const onSelectTransitionRef = useRef(onSelectTransition);

  useEffect(() => {
    onSelectNodeRef.current = onSelectNode;
    onSelectTransitionRef.current = onSelectTransition;
  }, [onSelectNode, onSelectTransition]);

  useEffect(() => {
    if (!containerRef.current || tree.nodes.length === 0) return;
    const singleNode = tree.nodes.length === 1;
    const cy = cytoscape({
      container: containerRef.current,
      elements: buildElements(tree),
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
            shape: "roundrectangle"
          }
        },
        {
          selector: "node.unstable",
          style: { "background-color": "#c62828", "border-color": "#ef5350" }
        },
        {
          selector: "node.current",
          style: {
            "border-color": "#f2bd4a",
            "border-width": 4
          }
        },
        {
          selector: "node.terminal",
          style: { "border-color": "#90caf9", "border-style": "double", "border-width": 5 }
        },
        {
          selector: "edge",
          style: {
            label: "data(label)",
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "arrow-scale": 1,
            "font-size": 9,
            color: "#b0bec5",
            "text-background-color": "#0d1520",
            "text-background-opacity": 0.85,
            "text-background-padding": "2px",
            "line-color": "#546e7a",
            "target-arrow-color": "#546e7a",
            width: 1.5
          }
        }
      ],
      layout: singleNode
        ? { name: "preset" }
        : {
            name: "breadthfirst",
            directed: true,
            roots: ["tn_1"],
            animate: false,
            avoidOverlap: true,
            spacingFactor: 1.2,
            padding: 20
          }
    });

    const fitGraph = () => {
      cy.resize();
      if (singleNode) {
        cy.getElementById("tn_1").position({
          x: containerRef.current!.clientWidth / 2,
          y: containerRef.current!.clientHeight / 2
        });
        cy.zoom(1);
        cy.pan({ x: 0, y: 0 });
      } else {
        cy.fit(undefined, 20);
        if (cy.zoom() > 1) {
          cy.zoom(1);
          cy.center();
        }
      }
    };

    cy.on("tap", "node", (event) => onSelectNodeRef.current(event.target.data("stateNodeId")));
    cy.on("tap", "edge", (event) => {
      onSelectNodeRef.current(event.target.data("targetStateNodeId"));
      const transition = event.target.data("transition") as string;
      if (transition) onSelectTransitionRef.current(transition);
    });
    const observer = new ResizeObserver(fitGraph);
    observer.observe(containerRef.current);
    requestAnimationFrame(fitGraph);
    cyRef.current = cy;

    return () => {
      observer.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, [tree]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass("current");
    if (currentNodeId != null) cy.getElementById(`tn_${currentNodeId}`).addClass("current");
  }, [currentNodeId, tree]);

  if (tree.nodes.length === 0) {
    return <div className="state-tree-empty">Run Simulate to create the first state.</div>;
  }

  return (
    <div className="state-tree-graph-shell">
      <div aria-label="State tree" className="state-tree-canvas" ref={containerRef} />
    </div>
  );
}
