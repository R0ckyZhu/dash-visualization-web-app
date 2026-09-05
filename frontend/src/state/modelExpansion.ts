import type { DashModel, DashState, DashTransition } from "../api/types";

export interface ExpandedModelResult {
  model: DashModel;
  paramInstances: Record<string, string[]>;
}

export function expandParameterizedModel(
  model: DashModel,
  sigScopes: Record<string, number>
): ExpandedModelResult {
  if (Object.keys(sigScopes).length === 0) {
    return { model, paramInstances: {} };
  }

  const paramRoots = new Map<string, string>();
  for (const state of model.states) {
    for (const param of state.params ?? []) {
      if (!paramRoots.has(param.paramSig)) {
        paramRoots.set(param.paramSig, param.stateName);
      }
    }
  }

  if (paramRoots.size === 0) {
    return { model, paramInstances: {} };
  }

  const paramInstances: Record<string, string[]> = {};
  for (const [sig] of paramRoots) {
    const count = Math.max(1, Math.floor(sigScopes[sig] ?? 1));
    paramInstances[sig] = Array.from({ length: count }, (_, index) => `${sig}_${index}`);
  }

  const paramStateIds = new Set(
    model.states.filter((state) => (state.params?.length ?? 0) > 0).map((state) => state.id)
  );
  const paramTransitionIds = new Set(
    model.transitions
      .filter(
        (transition) =>
          (transition.from != null && paramStateIds.has(transition.from)) ||
          (transition.to != null && paramStateIds.has(transition.to))
      )
      .map((transition) => transition.id)
  );
  const paramRootIds = new Set(paramRoots.values());

  function expandChildList(children: string[]) {
    return children.flatMap((childId) => {
      if (!paramRootIds.has(childId)) return [childId];
      const entry = [...paramRoots.entries()].find(([, rootId]) => rootId === childId);
      if (!entry) return [childId];
      const [sig] = entry;
      return paramInstances[sig].map((instance) => `${childId}[${instance}]`);
    });
  }

  const expandedStates: DashState[] = model.states
    .filter((state) => !paramStateIds.has(state.id))
    .map((state) => ({ ...state, children: expandChildList(state.children) }));
  const expandedTransitions: DashTransition[] = model.transitions
    .filter((transition) => !paramTransitionIds.has(transition.id))
    .map((transition) => ({ ...transition }));

  for (const [sig, rootStateId] of paramRoots) {
    for (const instance of paramInstances[sig]) {
      const suffix = `[${instance}]`;
      const rewriteId = (id: string) => (paramStateIds.has(id) ? `${id}${suffix}` : id);

      for (const state of model.states) {
        if (!paramStateIds.has(state.id)) continue;
        expandedStates.push({
          ...state,
          id: `${state.id}${suffix}`,
          parent: state.parent ? rewriteId(state.parent) : state.parent,
          children: state.children.map(rewriteId),
          _paramInstance: instance,
          _originalId: state.id,
          _isParamRoot: state.id === rootStateId
        });
      }

      for (const transition of model.transitions) {
        if (!paramTransitionIds.has(transition.id)) continue;
        expandedTransitions.push({
          ...transition,
          id: `${transition.id}${suffix}`,
          from: transition.from ? rewriteId(transition.from) : transition.from,
          to: transition.to ? rewriteId(transition.to) : transition.to,
          _paramInstance: instance,
          _originalId: transition.id
        });
      }
    }
  }

  return {
    model: {
      ...model,
      states: expandedStates,
      transitions: expandedTransitions,
      _paramInstances: paramInstances
    },
    paramInstances
  };
}
