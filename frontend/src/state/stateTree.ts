import { snapshotKey, type TraceSnapshot } from "./trace";

export interface StateTreeNode {
  id: number;
  label: string;
  snapshot: TraceSnapshot;
}

export interface StateTreeEdge {
  id: string;
  source: number;
  target: number;
  transition: string;
}

export interface StateTree {
  nodes: StateTreeNode[];
  edges: StateTreeEdge[];
  nextId: number;
}

export interface StateTreeExtension {
  tree: StateTree;
  nodeIds: number[];
  snapshots: TraceSnapshot[];
}

export interface StateTreePath {
  nodeIds: number[];
  snapshots: TraceSnapshot[];
}

export function emptyStateTree(): StateTree {
  return { nodes: [], edges: [], nextId: 1 };
}

export function createInitialStateTree(snapshot: TraceSnapshot): StateTreeExtension {
  const labeledSnapshot = { ...snapshot, label: "S1" };
  return {
    tree: {
      nodes: [{ id: 1, label: "S1", snapshot: labeledSnapshot }],
      edges: [],
      nextId: 2
    },
    nodeIds: [1],
    snapshots: [labeledSnapshot]
  };
}

export function reconstructStateTreePath(
  tree: StateTree,
  targetNodeId: number,
  rootNodeId = 1
): StateTreePath | null {
  const nodesById = new Map(tree.nodes.map((node) => [node.id, node]));
  if (!nodesById.has(rootNodeId) || !nodesById.has(targetNodeId)) return null;

  const incomingByTarget = new Map<number, StateTreeEdge[]>();
  for (const edge of tree.edges) {
    const incoming = incomingByTarget.get(edge.target) ?? [];
    incoming.push(edge);
    incomingByTarget.set(edge.target, incoming);
  }

  const queue = [targetNodeId];
  const visited = new Set(queue);
  const edgeTowardTarget = new Map<number, StateTreeEdge>();

  for (let index = 0; index < queue.length; index += 1) {
    const currentNodeId = queue[index];
    if (currentNodeId === rootNodeId) break;

    for (const edge of incomingByTarget.get(currentNodeId) ?? []) {
      if (visited.has(edge.source)) continue;
      visited.add(edge.source);
      edgeTowardTarget.set(edge.source, edge);
      queue.push(edge.source);
    }
  }

  if (!visited.has(rootNodeId)) return null;

  const nodeIds = [rootNodeId];
  const pathEdges: StateTreeEdge[] = [];
  let currentNodeId = rootNodeId;

  while (currentNodeId !== targetNodeId) {
    const edge = edgeTowardTarget.get(currentNodeId);
    if (!edge) return null;
    pathEdges.push(edge);
    nodeIds.push(edge.target);
    currentNodeId = edge.target;
  }

  const snapshots = nodeIds.map((nodeId, index) => {
    const snapshot = nodesById.get(nodeId)!.snapshot;
    const incomingEdge = pathEdges[index - 1];
    return incomingEdge
      ? { ...snapshot, takenTransitions: incomingEdge.transition ? [incomingEdge.transition] : [] }
      : { ...snapshot };
  });

  return { nodeIds, snapshots };
}

export function extendStateTree(
  current: StateTree,
  startNodeId: number,
  successors: TraceSnapshot[]
): StateTreeExtension {
  const nodes = current.nodes.map((node) => ({ ...node }));
  const edges = current.edges.map((edge) => ({ ...edge }));
  const bySnapshot = new Map(nodes.map((node) => [snapshotKey(node.snapshot.raw), node]));
  let nextId = current.nextId;
  let source = startNodeId;
  const nodeIds: number[] = [];
  const snapshots: TraceSnapshot[] = [];

  for (const successor of successors) {
    const key = snapshotKey(successor.raw);
    let node = bySnapshot.get(key);
    if (!node) {
      const label = `S${nextId}`;
      const labeledSnapshot = { ...successor, label };
      node = { id: nextId, label, snapshot: labeledSnapshot };
      nodes.push(node);
      bySnapshot.set(key, node);
      nextId += 1;
    } else if (successor.terminal && !node.snapshot.terminal) {
      node.snapshot = { ...node.snapshot, terminal: true };
    }

    const transition = successor.takenTransitions[0] ?? "";
    if (source !== node.id) {
      const edgeKey = `${source}:${node.id}:${transition}`;
      if (!edges.some((edge) => edge.id === edgeKey)) {
        edges.push({ id: edgeKey, source, target: node.id, transition });
      }
    }

    nodeIds.push(node.id);
    snapshots.push({ ...successor, label: node.label });
    source = node.id;
  }

  return { tree: { nodes, edges, nextId }, nodeIds, snapshots };
}
