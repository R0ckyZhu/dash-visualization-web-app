# Full simulation process — elevator model

How the web app simulates a Dash model, end to end, illustrated with the
elevator model (`PID = 2` elevators, `Floor = 3`) and real artifacts from a
recorded session. Applies to `elevator-fixed.dsh` and any other model; the
elevator exercises every part of the pipeline (auto-injected param sig,
aliasless ordering, enum, multi-domain).

Participants: **frontend** (trace graph UI) → **FastAPI backend** (thin proxy)
→ **session server** (Java, `CommandRouter`) → **dashplus** (parser +
DashToAlloy translator) → **Alloy/kodkod** (solver). Every solve the session
server runs is dumped to `$TMPDIR/als-compare/webapp-NN-<phase>.als`.

---

## Phase 0 — load

`POST /api/load {filePath}` → dashplus parses the `.dsh` into a `DashModel`.

Elevator specifics: the model uses `conc Elevator [PID]` but never declares
`sig PID` — the session server detects this and injects `sig PID {}` into the
source before parsing (legacy models predate the translator requiring the
declaration). The response is the serialized DashModel (states, transitions,
vars) that the frontend uses to draw the state hierarchy.

## Phase 1 — translate

`POST /api/translate {option: "traces"}` → DashToAlloy produces the Alloy
model: `__Snapshot` sig with one field per variable plus per-depth machinery
(`__conf0/1`, `__taken0/1`, `__sc_used0/1`, `__stable`), a `pre`/`post`/
`trans` predicate triple per transition, `__trans_enabled`, `__small_step`,
and the model's own `__initial`.

The response includes `scopeSigs` — the sigs needing user scopes, detected as
plain top-level sigs: here `[PID, Floor]`. (`Direction` is an enum —
`abstract` + `one` children — so it is *not* scopable; its atoms `Up`/`Down`
are named constants.)

## Phase 2 — scopes

The user supplies atom counts: `sigScopes = {PID: 2, Floor: 3}`. From here on
every solve carries, for each scoped sig:

```alloy
one sig PID_0, PID_1 extends PID {}
one sig Floor_0, Floor_1, Floor_2 extends Floor {}
-- run clause: exactly 2 PID, exactly 3 Floor
```

These named atoms are what make state transportable between solves: `Floor_1`
denotes the same individual in every solve of the trace.

## Phase 3 — init solve (deliberately assumption-free)

`POST /api/init {sigScopes, mode: "simplified"}`. The session server assembles
a complete Alloy system:

```
open util/ordering[__Snapshot] as aldb_order      // trace order (wrapper's)
<translated model, __initial removed, concrete sigs spliced in its place>
<the model's own __initial, re-appended>          // = the init constraint
fact { __initial[aldb_order/first] }
fact { all s: __Snapshot, sprime: s.(aldb_order/next) { __small_step[s, sprime] } }
fact { __trans_enabled[aldb_order/last] }         // simplified mode (REQUIRE)
run { } for exactly 1 __Snapshot, exactly 2 PID, exactly 3 Floor
```

**No ordering pins are emitted at init.** The model opens
`util/ordering[Floor]` but the init solve leaves the order entirely to the
solver — no assumptions. In the recorded session the solver chose
`Floor_1 < Floor_0 < Floor_2`, visible in the returned snapshot: both
elevators start at `Floor_1` (`current = min[Floor]` in the model's init).

If REQUIRE is unsat, the solve retries with
`fact { not __trans_enabled[aldb_order/last] }` (FORBID); satisfiable there
means the initial state is a dead end, marked `terminal` (drawn as a
rectangle).

## Phase 4 — domain extraction from the first response

After a satisfiable init, the session server wraps the solution in dashplus's
`Solution` class, whose map exposes every relation of the kodkod instance as
`name -> tuples`. The map is split with **no structural assumptions**:

- **dynamic** (snapshot info): keys under `this/__Snapshot`, or relations
  whose tuples lead with a `__Snapshot` atom;
- **static bucket**: everything else, then filtered *subtractively* — drop
  skolems, bare `$` atom duplicates, library relations (`Int/*`, `boolean/*`,
  `seq/*`), wrapper/trace machinery (`aldb_order/*`, `__Snapshot/*`, `S/*`,
  `Time`, `loop`), translator infrastructure (`this/__*`), `*_remainder`
  partitions, and self-denoting singletons (states, transitions, events,
  concrete atoms — their values are forced by their declarations).

What survives is exactly the static info the solver was free to choose. For
the elevator, the recorded session kept:

```
ordering/Ord.First = Floor_1
ordering/Ord.Next  = Floor_1->Floor_0 ; Floor_0->Floor_2
```

rendered into pin facts (the aliasless `open util/ordering[Floor]` is
addressed through Alloy's implicit module qualifier `ordering/`):

```alloy
fact { ordering/first = Floor_1 }
fact { ordering/next = Floor_0->Floor_2 + Floor_1->Floor_0 }
```

These facts are carried into **every subsequent solve**, so "the ground
floor" means one fixed atom for the whole trace. (For a model with no
orderings — e.g. ehealth — the kept set is empty and no pins are emitted.)

## Phase 5 — steps

`POST /api/step {state, sigScopes, mode, constraints?}`. The clicked node's
snapshot travels back as JSON and is rebuilt into a fully concrete seed:

```alloy
pred __initial[s: one __Snapshot] {
    s.System_Controller_callToSend = Floor_0->Down + Floor_2->Down
    s.System_Elevator_called      = PID_0->Floor_1
    s.System_Elevator_current     = PID_0->Floor_1 + PID_1->Floor_1
    s.System_Elevator_direction   = PID_0->Up + PID_1->Up
    s.__conf0 = System_Controller_Sending
    s.__conf1 = PID_0->System_Elevator_Idle + PID_1->System_Elevator_Idle
    s.__stable = boolean/True    s.__taken0 = ...   // every field pinned
}
```

(The *first* step after init instead reuses the model's abstract `__initial`,
with the displayed snapshot's event fields pinned onto it.)

Assembly is the same as init, plus: the extracted domain pins, an (optionally
empty) user-constraint predicate applied to the **successor** —

```alloy
pred __cst[s: one __Snapshot] { <constraint panel entries> }
pred path[s: one __Snapshot] { __cst[s.(aldb_order/next)] }
fact { path[aldb_order/first] }
```

— and `run { } for exactly 2 __Snapshot, ...` (one small step: seed +
successor). Simplified mode again runs REQUIRE first (successor must itself
have an enabled transition), falling back to FORBID; a satisfiable FORBID
marks the successor `terminal`.

Constraint layers of a step solve, summarized:

| layer | content | source |
|---|---|---|
| domain | concrete atoms, `exactly N`, ordering pins | scopes + init-response extraction |
| seed | every snapshot field of the start node | previous solve's output |
| intent | `__cst` on the successor (forced transition, staged env inputs) | constraint panel |
| semantics | `__small_step` chain, `__trans_enabled` polarity | wrapper + translated model |

## Phase 6 — alternates

- **Alt** (`/api/solution/next`): enumerate the current solve's next
  satisfying instance (same constraints, different successor).
- **Alt Init** (`/api/solution/next-init`): enumerate alternative initial
  states — and **re-extract** domain info, since a different init may carry a
  different ordering choice.
- **Alt Trans** (`/api/solution/alt-trans`): step re-solved with
  `fact { some aldb_order/last.__taken0 and aldb_order/last.__taken0 not in (T1 + ...) }`
  forcing a transition not yet shown from this node.

## Worked run (elevator-fixed, recorded)

Ordering extracted at init: ground = F1, then F0, top = F2.

| step | taken | effect |
|---|---|---|
| S1 | — (init) | both elevators Idle at ground (F1); 3 Down calls pending |
| S2 | C.SendingDownRequest | call F1 → P0 (fallback dispatch; elevators framed) |
| S3 | P0 Idle_Move | P0 → MovingUp (big step of S2 completes) |
| S4 | P0 ElevatorInCalled | P0 already on called floor: call cleared in place |
| S5 | C.SendingDownRequest | call F0 → P1 |
| S6 | P1 Idle_Move | P1 → MovingUp |
| S7 | P1 MoveUp | **only movement:** P1 F1→F0, call consumed |
| S8 | P0 MovingUp_Idle | P0 back to Idle, stays at F1 (FIX 2) |
| S9 | C.SendingDownRequest | last call F2 → P1; callToSend empty |
| S10 | P1 MoveUp | P1 F0→F2 (top), call consumed |
| S11 | P1 MovingUp_Idle | P1 idle at top |
| S12 | P1 DefaultToGround | P1 parks at ground — **TERMINAL** (proved: REQUIRE unsat, FORBID sat) |

The model is a closed system (3 calls at init, no env events, nothing
replenishes `callToSend`), so every trace ends in this quiescent state:
all calls served, all elevators parked at ground, nothing enabled.

## Debug artifacts

Every solve's full `.als` text: `$TMPDIR/als-compare/webapp-NN-<phase>.als`
(`init`, `step`, and `-terminal` for FORBID retries; counter resets when the
backend restarts). Extraction results are logged to the backend console:
`domain info kept from init response: [...]` and the rendered pin facts.
