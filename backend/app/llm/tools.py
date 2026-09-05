from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..session_context import AppSessionContext


class NoArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EntityArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=512)


class CompareSnapshotArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    left_id: str = Field(min_length=1, max_length=512)
    right_id: str = Field(min_length=1, max_length=512)


ToolHandler = Callable[[BaseModel], Any]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    arguments: type[BaseModel]
    handler: ToolHandler


class ToolExecutionError(ValueError):
    pass


class SessionToolRegistry:
    def __init__(self, session: AppSessionContext):
        self.session = session
        self._tools = {
            spec.name: spec
            for spec in [
                ToolSpec(
                    "get_model_summary",
                    "Return the complete parsed model structure and entity counts.",
                    NoArguments,
                    self._get_model_summary,
                ),
                ToolSpec(
                    "get_model_source",
                    "Return the complete loaded Dash+ (.dsh) source.",
                    NoArguments,
                    self._get_model_source,
                ),
                ToolSpec(
                    "get_translated_alloy",
                    "Return the complete translated Alloy module.",
                    NoArguments,
                    self._get_translated_alloy,
                ),
                ToolSpec(
                    "get_generated_alloy",
                    "Return Alloy and wrapper fragments generated for the latest solve.",
                    NoArguments,
                    self._get_generated_alloy,
                ),
                ToolSpec(
                    "get_current_snapshot",
                    "Return the snapshot at the current trace cursor.",
                    NoArguments,
                    self._get_current_snapshot,
                ),
                ToolSpec(
                    "get_snapshot",
                    "Return a snapshot by snapshot hash, state-tree node ID, or S-label.",
                    EntityArguments,
                    self._get_snapshot,
                ),
                ToolSpec(
                    "get_current_trace",
                    "Return the current root-to-cursor trace and its connecting edges.",
                    NoArguments,
                    self._get_current_trace,
                ),
                ToolSpec(
                    "get_state_tree",
                    "Return every state-tree node and edge currently discovered.",
                    NoArguments,
                    self._get_state_tree,
                ),
                ToolSpec(
                    "get_state_details",
                    "Return parsed model data for a state ID.",
                    EntityArguments,
                    lambda args: self._model_entity("states", args.id),
                ),
                ToolSpec(
                    "get_transition_details",
                    "Return parsed model data for a transition ID.",
                    EntityArguments,
                    lambda args: self._model_entity("transitions", args.id),
                ),
                ToolSpec(
                    "get_event_details",
                    "Return parsed model data for an event ID.",
                    EntityArguments,
                    lambda args: self._model_entity("events", args.id),
                ),
                ToolSpec(
                    "get_variable_details",
                    "Return parsed model data for a variable ID.",
                    EntityArguments,
                    lambda args: self._model_entity("vars", args.id),
                ),
                ToolSpec(
                    "get_active_constraints",
                    "Return constraints, scopes, and simulation mode in force.",
                    NoArguments,
                    self._get_active_constraints,
                ),
                ToolSpec(
                    "compare_snapshots",
                    "Compare two snapshots and return fields whose solver values differ.",
                    CompareSnapshotArguments,
                    self._compare_snapshots,
                ),
            ]
        }

    def definitions(self) -> list[dict[str, Any]]:
        definitions = []
        for spec in self._tools.values():
            schema = spec.arguments.model_json_schema()
            schema["additionalProperties"] = False
            definitions.append(
                {
                    "type": "function",
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": schema,
                    "strict": True,
                }
            )
        return definitions

    def execute(self, name: str, raw_arguments: str) -> Any:
        spec = self._tools.get(name)
        if spec is None:
            raise ToolExecutionError(f"Unknown tool: {name}")
        try:
            values = json.loads(raw_arguments or "{}")
            arguments = spec.arguments.model_validate(values)
        except (json.JSONDecodeError, ValidationError) as exc:
            raise ToolExecutionError(f"Invalid arguments for {name}: {exc}") from exc
        return spec.handler(arguments)

    def _model_entities(self, collection: str) -> list[dict[str, Any]]:
        if not self.session.model:
            return []
        entities = self.session.model.get(collection, [])
        return entities if isinstance(entities, list) else []

    def _model_entity(self, collection: str, entity_id: str) -> dict[str, Any]:
        entity = next(
            (
                item
                for item in self._model_entities(collection)
                if item.get("id") == entity_id
            ),
            None,
        )
        if entity is None:
            return {"found": False, "id": entity_id, "collection": collection}
        return {"found": True, "entity": entity}

    def _tree_node(self, identifier: str | int | None):
        if identifier is None:
            return None
        return next(
            (
                node
                for node in self.session.state_tree_nodes
                if str(node.get("id")) == str(identifier)
                or node.get("label") == str(identifier)
            ),
            None,
        )

    def _snapshot(self, identifier: str | int | None):
        if identifier is None:
            return None
        if str(identifier) in self.session.snapshots:
            return {
                "snapshotId": str(identifier),
                "snapshot": self.session.snapshots[str(identifier)],
            }
        node = self._tree_node(identifier)
        if node:
            return {
                "nodeId": node.get("id"),
                "label": node.get("label"),
                "snapshot": node.get("snapshot"),
            }
        return None

    def _get_model_summary(self, _args: BaseModel):
        model = self.session.model
        if not model:
            return {"loaded": False}
        return {
            "loaded": True,
            "rootName": model.get("rootName"),
            "counts": {
                "states": len(self._model_entities("states")),
                "transitions": len(self._model_entities("transitions")),
                "events": len(self._model_entities("events")),
                "variables": len(self._model_entities("vars")),
                "buffers": len(self._model_entities("buffers")),
            },
            "model": model,
            "scopeSigs": self.session.scope_sigs,
        }

    def _get_model_source(self, _args: BaseModel):
        return {
            "file": self.session.source_path,
            "source": self.session.dsh_source,
        }

    def _get_translated_alloy(self, _args: BaseModel):
        return {"alloy": self.session.alloy_source}

    def _get_generated_alloy(self, _args: BaseModel):
        return self.session.generated_alloy or {"available": False}

    def _get_current_snapshot(self, _args: BaseModel):
        current = self._snapshot(self.session.cursor_node_id)
        if current:
            return {"found": True, **current}
        latest = self.session.latest_solution or {}
        snapshots = latest.get("snapshots", []) or []
        if snapshots:
            return {"found": True, "snapshot": snapshots[-1]}
        return {"found": False}

    def _get_snapshot(self, args: EntityArguments):
        snapshot = self._snapshot(args.id)
        return {"found": snapshot is not None, **(snapshot or {"id": args.id})}

    def _get_current_trace(self, _args: BaseModel):
        node_ids = self.session.trace_node_ids
        node_set = {str(node_id) for node_id in node_ids}
        nodes = [
            node
            for node_id in node_ids
            if (node := self._tree_node(node_id)) is not None
        ]
        edges = [
            edge
            for edge in self.session.state_tree_edges
            if str(edge.get("source")) in node_set
            and str(edge.get("target")) in node_set
        ]
        return {
            "cursorNodeId": self.session.cursor_node_id,
            "nodeIds": node_ids,
            "nodes": nodes,
            "edges": edges,
        }

    def _get_state_tree(self, _args: BaseModel):
        return {
            "nodes": self.session.state_tree_nodes,
            "edges": self.session.state_tree_edges,
        }

    def _get_active_constraints(self, _args: BaseModel):
        return {
            "constraints": self.session.constraints,
            "sigScopes": self.session.sig_scopes,
            "simulationMode": self.session.simulation_mode,
        }

    def _compare_snapshots(self, args: CompareSnapshotArguments):
        left = self._snapshot(args.left_id)
        right = self._snapshot(args.right_id)
        if not left or not right:
            return {
                "found": False,
                "missing": [
                    identifier
                    for identifier, value in (
                        (args.left_id, left),
                        (args.right_id, right),
                    )
                    if value is None
                ],
            }

        left_raw = left.get("snapshot", {})
        right_raw = right.get("snapshot", {})
        if isinstance(left_raw, dict) and "raw" in left_raw:
            left_raw = left_raw["raw"]
        if isinstance(right_raw, dict) and "raw" in right_raw:
            right_raw = right_raw["raw"]
        fields = sorted(set(left_raw) | set(right_raw))
        differences = {
            field: {"left": left_raw.get(field), "right": right_raw.get(field)}
            for field in fields
            if left_raw.get(field) != right_raw.get(field)
        }
        return {"found": True, "differences": differences}
