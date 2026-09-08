# Counter behavior investigation

Status: reported; not yet reproduced or diagnosed.

Unexpected behavior was observed while running a Counter model. The exact model
file, scope values, simulation mode, action sequence, and expected versus actual
results have not yet been recorded. Do not assign the cause to the model,
translator, solver, or visualization until a reproducible example distinguishes
these possibilities.

## Capture during the walkthrough

1. Repository commit, operating system, Java version, and Python version.
2. Exact model file or example collection/name. Several examples use Counter as
   the model's root name; that label alone does not identify the source.
3. Scope values, simulation mode, saved constraints, and whether constraints are
   enabled.
4. Actions from a fresh model load to the first unexpected result, including any
   alternative actions or selection of an earlier snapshot.
5. The expected state, variable, event, or transition change and what appeared
   instead. Record the last correct and first incorrect snapshots.
6. At that point, capture the statechart, inspector, events/variables tables,
   and expanded raw solver response, plus relevant terminal errors.
7. Save the Dash source and translated Alloy used for the reproduction.

## Investigation sequence

- Reproduce using the same source, settings, and action sequence.
- Compare the rendered state and table values with the raw solver snapshot.
  A disagreement points to the frontend's interpretation or display and must be
  traced through parameter mapping and the selected tree/trace cursor.
- If the display matches the raw snapshot, inspect the generated Alloy against
  the intended Dash transition, guards, events, and assignments. Check the
  model's own assumptions before concluding that translation is incorrect.
- Reduce the example to the smallest failing configuration and add a regression
  test for the expected behavior before implementing a fix.

Previous checks covered initialization, three steps, contradictory-constraint
rejection, and before/after trace equality for selected models and modes. Those
checks show that the tested redesign preserved those sampled results; an
existing defect could pass both runs. They do not resolve this report.
