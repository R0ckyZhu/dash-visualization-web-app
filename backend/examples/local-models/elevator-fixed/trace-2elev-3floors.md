# elevator-fixed: recorded simulation trace

Config: `PID = 2` elevators, `Floor = 3`, simplified mode.
Extracted ordering (from the init response): `Floor_1 < Floor_0 < Floor_2`
→ building bottom-to-top: **F1 (ground), F0 (middle), F2 (top)**.

Each UI step is one *small step*; `stable = False` means the big step continues
in the next snapshot. No env events exist in this model — the Controller acts on
its own `when` conditions.

| | conf | current | dir | called | callToSend | taken | stable |
|--|--|--|--|--|--|--|--|
| S1 | C.Sending, P0/P1 Idle | P0:F1 P1:F1 | Up Up | — | F0,F1,F2→Down | — | ✔ |
| S2 | unchanged | unchanged | unchanged | P0:{F1} | F0,F2→Down | C.SendingDownRequest | ✘ |
| S3 | P0→MovingUp | unchanged | unchanged | P0:{F1} | F0,F2→Down | P0 Idle_Move | ✔ |
| S4 | unchanged | unchanged | unchanged | — | F0,F2→Down | P0 ElevatorInCalled | ✘ |
| S5 | unchanged | unchanged | unchanged | P1:{F0} | F2→Down | C.SendingDownRequest | ✘ |
| S6 | P1→MovingUp | unchanged | unchanged | P1:{F0} | F2→Down | P1 Idle_Move | ✔ |
| S7 | unchanged | P1: F1→**F0** | unchanged | — | F2→Down | P1 MoveUp | ✘ |
| S8 | P0→Idle | unchanged | unchanged | — | F2→Down | P0 MovingUp_Idle | ✘ |
| S9 | unchanged | unchanged | unchanged | P1:{F2} | — | C.SendingDownRequest | ✔ |

## Step-by-step

- **S1 (init).** Both elevators idle at the ground floor (`current = min[Floor]` = F1),
  facing Up, no assigned calls. The controller holds three pending Down calls, one per
  floor. Stable: a fresh big step can start.
- **S1→S2.** `SendingDownRequest` fires (`Down in Floor.callToSend`). The smart-dispatch
  condition (an elevator with `direction = Down` at/above the call) fails — both face Up —
  so the fallback `SendRequest` assigns an arbitrary call: F1 goes to P0. `FrameElevators`
  keeps positions/directions untouched (pre-fix, this step could relocate both cars).
  Unstable: the big step continues.
- **S2→S3.** P0 reacts within the same big step: `Idle_Move` (it now has a call) moves its
  control state to MovingUp. Pure control-state change — the fixed do-block pins
  current/direction/called explicitly. Big step ends (stable).
- **S3→S4.** New big step. P0's call set is {F1} and it is standing at F1:
  `ElevatorInCalled` consumes the call (`called' = called - current`). Position and
  direction held by the explicit frames.
- **S4→S5.** Still in the same big step, the controller dispatches again: fallback
  `SendRequest` hands F0 to P1. (The smart branch again fails: no elevator faces Down.)
- **S5→S6.** P1 reacts: `Idle_Move` → MovingUp. Big step ends.
- **S6→S7.** P1 executes `MoveUp`: target `min[nexts[F1] & {F0}]` = F0 — one floor up
  (F0 is directly above ground in this trace's ordering). Call consumed on arrival
  (`called' = called - current'`). This is the *only* position change in the whole trace,
  and it happens on a Move transition — exactly the invariant the fixes establish.
- **S7→S8.** P0, in MovingUp with no calls, takes the repaired `MovingUp_Idle`: control
  state returns to Idle and the car **stays at F1** (the original model teleported here —
  `current'` was unconstrained).
- **S8→S9.** The controller dispatches the last call: F2 (top floor) to P1, emptying
  `callToSend`. Stable. In the next big step P1 (at F0, facing Up, called {F2}) would
  `MoveUp` to the top floor.

## Invariants visible in the trace

1. `current` changes only on `MoveUp` (S7) — never on controller or bookkeeping steps.
2. `direction` never changes (no `ChangeDir*` fired) — pre-fix it flipped repeatedly.
3. Calls never hop between elevators: each `called` entry is created by exactly one
   controller dispatch and destroyed by exactly one consume (`ElevatorInCalled`/`MoveUp`).
4. The ground floor is the same atom (F1) at every snapshot — ordering pinned from the
   init response.
