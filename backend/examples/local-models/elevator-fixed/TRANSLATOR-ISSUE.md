# Possible translator issue: missing or too-weak frame conditions

**Component:** dashplus `dashtoalloy/TransPostD2A.java` (`addVarConstraints`)
**Evidence model:** `backend/examples/2022-tamjid-thesis/elevator/elevator.dsh`
(controller + 2 elevators, 3 floors)
**Symptom:** in simulation, elevators change floors on steps where no movement
transition fired, directions flip on their own, and pending calls jump from one
elevator to another.

---

## Terminology (with this model's values)

**Snapshot.** One state of the whole system at one moment. A step relates two
snapshots: `s` (before) and `sn` (after).

**Variable / primed variable.** `current` is an elevator's floor. Unprimed
`current` means its value in `s`; primed `current'` means its value in `sn`.
A transition's `do` block writes primed variables: `current' = current` says
"the floor after the step equals the floor before it."

**Parameterized variable.** `current` is declared inside `conc Elevator [PID]`,
so every elevator has its own copy. In the generated Alloy the copies are stored
together as **one relation of pairs (which elevator, its value)**:

```
s.System_Elevator_current   = { P0→F1,  P1→F2 }     // "P0 is at floor F1, P1 at F2"
s.System_Elevator_direction = { P0→Up,  P1→Down }
s.System_Elevator_called    = { P1→F0,  P1→F2 }     // P1 must visit F0 and F2; P0 has no calls
```

The elements are **pairs of atoms**: an elevator atom (`PID_0`, `PID_1` — written
P0, P1 here) paired with a floor atom or direction atom.

**Frame (frame condition).** A constraint that says a variable does **not**
change across a step. Alloy has no built-in "everything else stays the same":
if neither the `do` block nor a frame constrains `current'`, then *any* floor
assignment in `sn` is a legal outcome — the solver picks freely. Frames are what
rule that out.

**Join / image (the `PID.(...)` operation).** `PID.(s.direction)` composes the
set of all elevator atoms with the direction relation, which **erases the
"which elevator" column** and leaves only the set of values in use:

```
s.direction  = { P0→Up, P1→Down }
PID.(s.direction) = { Up, Down }          // just the values; who has what is gone
```

**Set-image equality (the weak frame).** The constraint

```alloy
PID.(s.direction) = PID.(sn.direction)
```

says only: "the set of directions in use is the same before and after."
It does **not** say each elevator keeps its own direction. Both of these
successors satisfy it:

```
before:  { P0→Up, P1→Down }        image {Up, Down}
after A: { P0→Up, P1→Down }        image {Up, Down}   ← unchanged (intended)
after B: { P0→Down, P1→Up }        image {Up, Down}   ← SWAPPED (also allowed!)
```

**Per-instance equality (the strong frame).** The constraint

```alloy
all e: PID | e.(sn.direction) = e.(s.direction)
```

says: each elevator individually keeps its direction. Only "after A" above
satisfies it. This is the form the elevator model's own author uses manually
(see below), and the form the fixed model adds everywhere.

---

## Defect 1 — untouched variables get only the weak (set-image) frame

When a transition's `do` block doesn't mention a variable, the translator adds a
frame for it — but the set-image kind. From the generated post-condition of
`DefaultToGround` (a transition that only writes the acting elevator's
`current'`):

```alloy
PID.(s.System_Elevator_direction) = PID.(sn.System_Elevator_direction)  // weak
PID.(s.System_Elevator_called)    = PID.(sn.System_Elevator_called)     // weak
s.System_Controller_callToSend    = sn.System_Controller_callToSend     // exact —
                                    // callToSend has no elevator parameter, so
                                    // plain equality IS the strong frame here
```

The generator source shows the set-image is deliberate:

```java
// don't need to quantify over each p:ParamSig,
// rather just equate the sets of all values
```

That comment is the bug: for per-elevator values, equating "the sets of all
values" is strictly weaker than "each elevator keeps its value."

**Observed consequence — a call jumps between elevators.** One recorded step
where `DefaultToGround` fired (a transition that never mentions `called`):

```
before: called = { P1→F0, P1→F1, P1→F2 }      image = {F0, F1, F2}
after:  called = { P0→F1, P0→F2, P1→F0 }      image = {F0, F1, F2}  ✓ frame holds
```

Calls F1 and F2 moved from elevator P1's queue to P0's. The weak frame is
satisfied — the *set of called floors* didn't change — but ownership did,
which no transition authorized.

## Defect 2 — some variables get **no frame at all**

When the `do` block *does* mention a variable, the translator tries to frame
just the untouched part — e.g. "every elevator except the acting one keeps its
value." But it can only work out which part is untouched if the variable is
indexed by the transition's own parameter (the acting elevator). If the model
refers to the variable through a locally-quantified name instead — like the
Controller's `Elevator[e0]/called'`, where `e0` is chosen by a `one e0: PID`
inside the predicate — the generator gives up **silently**:

```java
if (!dR.paramValues.get(i).equals(params.get(i).asIndexValue())) {
    noExprForThisVar = true;      // reference not indexed by own parameter...
}
...
if (!noExprForThisVar) { body.add(AlloyEqual(left, right)); }
// ...so no frame of any kind is emitted
```

Controller transitions refer to *all* elevator variables this way — including
`current` and `direction`, which they only **read** in guards and could never
change. Result: the generated post of `SendingDownRequest` constrains
`called'` (partly) and `callToSend'`, and contains **not a single constraint**
on `sn.…current` or `sn.…direction`. Any placement of the elevators is a legal
successor of a dispatch step.

**Observed consequence — a dispatch step moves both elevators.** Two
consecutive snapshots, transition taken = `SendingDownRequest` (whose entire
job is moving one call from the pool into one queue):

```
before: current = { P0→F0, P1→F0 }    direction = { P0→Up,   P1→Up }
after:  current = { P0→F1, P1→F1 }    direction = { P0→Down, P1→Down }
```

**The model author knew.** Inside the dispatch predicates the original model
hand-writes the strong frame for the one variable the Controller *writes*:

```dash
all others: PID - e0 | Elevator[others]/called' = Elevator[others]/called
```

— per-instance, exactly what the generator should have produced — but the
author (understandably) didn't add the same for the variables the Controller
merely *reads*, and the generator added nothing either.

## Aggravating case — an unprimed equation in a `do` block

`MovingUp/Idle` in the source:

```dash
do { current = min[Floor] }      // note: current, NOT current'
```

Unprimed `current` is the *before* value, so this line is a **test on the state
before the step** ("the elevator is at the bottom floor"), not an update. The
translator places it faithfully in the post-condition as a constraint on `s` —
and since nothing writes `current'` and the frame only covers the *other*
elevators, the acting elevator's landing floor is completely unconstrained:

```alloy
(PID - p).(s.current) = (PID - p).(sn.current)     // others keep their floors
{ p.(s.current) = min[Floor] }                      // tests the BEFORE state
// p.(sn.current) : appears nowhere → any floor is a legal landing spot
```

Observed: an elevator standing at the top floor "went idle" and materialized at
a different floor.

Side effect on tooling: `__trans_enabled` (used to detect dead ends) checks
only transition **pre**-conditions, but this test sits in the **post** — so a
state can look "live" to `__trans_enabled` while no transition can actually
fire from it.

## Impact

The model parses, translates, and solves without any warning, but simulation
traces show physically impossible behavior. Each spurious successor is
individually consistent, so property checks don't flag it; it only shows up as
trace-level nonsense that is expensive to attribute without dumping and reading
the generated post-conditions.

## Suggested fixes

1. Emit **per-instance** frames for untouched parameterized variables
   (`all e: PID | e.(sn.x) = e.(s.x)`) instead of set-images.
2. In the give-up case, distinguish reads from writes: a variable that appears
   only unprimed cannot change — frame it fully. If a *primed* reference truly
   can't be analyzed, print a warning instead of staying silent.
3. Warn on (or reject) unprimed equations in `do` blocks — almost always a
   modeling mistake, and it silently breaks `__trans_enabled`'s meaning.

## Repro

1. Load the original elevator model, scopes `PID = 2, Floor = 3`, simplified
   mode; run init + steps. Every solver input is dumped to
   `$TMPDIR/als-compare/webapp-NN-*.als`; the Alloy excerpts above are verbatim
   from those dumps.
2. In any dump, check each `*_post` predicate for `sn.System_Elevator_current`
   / `direction` / `called`: classify as exact, set-image, or absent.
3. Compare against `elevator-fixed.dsh` in this folder: adding the strong
   frames by hand (see `FIXES.md`) eliminates all drift at 2 elevators
   (`trace-2elev-3floors.md`). What hand-fixes cannot repair: with 3+
   elevators, the set-image frames still allow the *non-acting* elevators to
   swap values among themselves — that part only a translator fix can close.
