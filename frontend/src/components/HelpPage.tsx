import { useEffect, useRef } from "react";

const sections = [
  { id: "help-start", title: "Getting started" },
  { id: "help-library", title: "Example library" },
  { id: "help-scopes", title: "Scopes" },
  { id: "help-controls", title: "Simulation controls" },
  { id: "help-views", title: "Views" },
  { id: "help-concepts", title: "Concepts" },
  { id: "help-tips", title: "Tips" },
];

export function HelpPage({ onClose }: { onClose: () => void }) {
  const pageRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    pageRef.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  return (
    <section
      className="help-page"
      aria-labelledby="help-title"
      ref={pageRef}
      tabIndex={-1}
    >
      <div className="help-inner">
        <header className="help-header">
          <div>
            <p className="eyebrow">HELP</p>
            <h1 id="help-title">Using the Dash+ Visualizer</h1>
          </div>
          <button type="button" onClick={onClose}>
            Close help
          </button>
        </header>
        <p className="help-lead">
          The Dash+ Visualizer lets you explore how a Dash+ model behaves by
          simulating it. Dash+ describes systems as hierarchical, concurrent
          state machines on top of Alloy. The app translates your model to
          Alloy and asks the Alloy solver for <em>snapshots</em> (complete
          states of the system) and the <em>steps</em> between them, then shows
          them in coordinated views.
        </p>

        <nav className="help-toc" aria-label="Help contents">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() =>
                document
                  .getElementById(section.id)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            >
              {section.title}
            </button>
          ))}
        </nav>

        <section id="help-start">
          <h2>Getting started</h2>
          <ol>
            <li>
              Pick a model from the example library. You can switch models at
              any time with <b>Open Dash+ model</b> in the header.
            </li>
            <li>
              If the model needs scopes, check them and press{" "}
              <b>Start simulation</b> in the dialog. Otherwise press{" "}
              <b>Start simulation</b> in the toolbar. The solver finds an
              initial snapshot, <b>S1</b>.
            </li>
            <li>
              Press <b>Step →</b> to move one step forward from the current
              snapshot.
            </li>
            <li>
              Use <b>Alternatives</b> to see other possibilities, and click any
              snapshot in the Kripke structure to go back to it and branch from
              there.
            </li>
          </ol>
        </section>

        <section id="help-library">
          <h2>Example library</h2>
          <p>The bundled case studies are listed in two groups:</p>
          <dl>
            <dt>Non-parameterized models</dt>
            <dd>Every state and region of the statechart exists exactly once.</dd>
            <dt>Parameterized models</dt>
            <dd>
              Models that contain parameterized processes, shown in the
              statechart as <code>Elevator[PID_0]</code>,{" "}
              <code>Elevator[PID_1]</code> and so on.
            </dd>
          </dl>
        </section>

        <section id="help-scopes">
          <h2>Scopes</h2>
          <p>
            A scope says exactly how many atoms a signature has. With{" "}
            <code>Floor</code> at 3, the atoms <code>Floor_0</code>,{" "}
            <code>Floor_1</code> and <code>Floor_2</code> exist for the whole
            simulation. For a parameterized model, the scope of its signature is
            the number of copies of the parameterized region.
          </p>
          <p>
            Some models only have an initial snapshot at particular scopes. The
            elevator needs three floors, and musical chairs needs one more
            player than chairs. Bundled examples open with scopes that work.
            Change them with the <b>Scopes</b> button in the toolbar; starting
            with new scopes replaces the current trace and Kripke structure.
          </p>
        </section>

        <section id="help-controls">
          <h2>Simulation controls</h2>
          <dl>
            <dt>Start simulation / Restart simulation</dt>
            <dd>Ask the solver for a fresh initial snapshot and clear the run.</dd>
            <dt>Step →</dt>
            <dd>
              Find one successor of the current snapshot. The app always
              simulates in <em>simplified mode</em>: the solver prefers
              successors from which the simulation can continue.
            </dd>
            <dt>Alternatives</dt>
            <dd>
              <ul>
                <li>
                  <b>Alternative initial snapshot</b>: another solution for S1.
                  This starts the trace again.
                </li>
                <li>
                  <b>Alternative transition</b>: from the previous snapshot,
                  take a transition that has not been tried from it yet.
                </li>
                <li>
                  <b>Alternative snapshot</b>: another successor of the
                  previous snapshot that differs in any value, for example
                  different environment inputs.
                </li>
              </ul>
            </dd>
            <dt>Snapshot badge</dt>
            <dd>
              The right end of the toolbar shows the current snapshot and
              whether it is stable.
            </dd>
          </dl>
        </section>

        <section id="help-views">
          <h2>Views</h2>
          <p>
            The left panel switches between three views with the tabs in the
            header. The Explored Kripke Structure is always shown on the right.
            Selecting a state, transition or snapshot in one view highlights it
            in the others.
          </p>

          <h3>Static Model Hierarchy</h3>
          <ul>
            <li>
              The statechart of the model. Nested boxes show the state
              hierarchy; concurrent regions have solid borders and
              exclusive-choice regions dashed ones. Default states are orange.
            </li>
            <li>
              The states active in the current snapshot are outlined in green,
              and the transition taken into it is drawn in green.
            </li>
            <li>
              Click a state or transition to see its <b>State info</b> or{" "}
              <b>Transition info</b> (type, parent, default, guard, action and
              so on). <b>Browse states and transitions</b> lists them all.
            </li>
            <li>
              <b>Show static model info</b> lists what stays fixed for the
              whole trace: each signature with its atoms, constants such as{" "}
              <code>Const.maxNbLoans = 7</code>, orderings the solver chose
              (which need not follow the atom names, for example{" "}
              <code>Floor_2 &lt; Floor_0 &lt; Floor_1</code>), the integer range
              and the opened library modules. It is filled in once a
              simulation starts.
            </li>
            <li>
              <b>Fit</b>, <b>+</b> and <b>−</b> adjust the view; drag to pan
              and scroll to zoom. <b>Export PNG</b> saves the statechart as an
              image.
            </li>
          </ul>

          <h3>Trace View</h3>
          <ul>
            <li>
              A table with one column per snapshot on the current path, from S1
              to the end of the branch you are on.
            </li>
            <li>
              Rows hold everything about each snapshot: the transition taken
              into it and whether it is stable, then one row per state (● when
              active), per event (● when present; parameterized events list
              their instances) and per variable.
            </li>
            <li>
              Filter rows by name or by kind (Steps, States, Events,
              Variables). <b>Highlight changes</b> marks cells that differ from
              the previous snapshot; <b>Changed rows only</b> hides rows that
              never change; <b>Hide states and events never present</b> hides
              rows that are empty along the whole path.
            </li>
            <li>
              Click a column header to make that snapshot current, a state name
              to select the state, or a transition cell to select the
              transition. <b>Raw solver responses</b> shows the solver's data
              for each snapshot.
            </li>
          </ul>

          <h3>Model Source</h3>
          <p>
            The Dash+ source of the model next to the Alloy it is translated
            into.
          </p>

          <h3>Explored Kripke Structure</h3>
          <ul>
            <li>
              Each distinct snapshot found so far is a node, and each step is an
              edge labelled with its transition and triggering event, such as{" "}
              <code>T4 on Change</code>. Reaching a snapshot again reuses its
              node, so cycles and self-loops appear.
            </li>
            <li>
              Rectangles are stable snapshots and triangles unstable ones. The
              current snapshot has a gold border and the current path is blue;
              a selected transition is orange.
            </li>
            <li>
              Click a node to make it the current snapshot; the next Step
              branches from there. Click an edge to select its transition.
            </li>
            <li>
              <b>Show events</b> and <b>Show variables</b> overlay the current
              snapshot's events or variable values on the graph.
            </li>
            <li>
              The snapshot info below the graph lists the current snapshot's
              stability, the transition taken into it, its active states,
              events and variables, and the raw solver response.
            </li>
          </ul>
        </section>

        <section id="help-concepts">
          <h2>Concepts</h2>
          <dl>
            <dt>Snapshot</dt>
            <dd>
              One complete state of the system: the active states, the values
              of all variables, the events present, and the transitions taken
              to reach it. Snapshots are labelled S1, S2, … in the order they
              were found.
            </dd>
            <dt>Step</dt>
            <dd>
              A move from one snapshot to the next by taking enabled
              transitions. A transition is enabled when its source state is
              active, its triggering event (if any) is present and its guard
              holds, subject to Dash+'s priority rules.
            </dd>
            <dt>Stable and unstable</dt>
            <dd>
              A big step is the system's complete response to the environment
              and can take several steps. A snapshot is stable when the big
              step has finished and unstable while it is still in progress.
              Models without big steps mark every snapshot stable.
            </dd>
            <dt>Environment inputs</dt>
            <dd>
              Variables declared <code>env</code> and environment events are
              chosen by the environment. The solver picks their values freely
              at each step.
            </dd>
            <dt>Static and dynamic</dt>
            <dd>
              Static information (atoms, constants, orderings, the statechart
              itself) is the same in every snapshot of a trace. Dynamic
              information (active states, variables, events, transitions taken)
              can differ from one snapshot to the next.
            </dd>
            <dt>Kripke structure</dt>
            <dd>
              The graph of a model's snapshots and the steps between them. The
              app shows the part you have explored so far.
            </dd>
          </dl>
        </section>

        <section id="help-tips">
          <h2>Tips</h2>
          <ul>
            <li>
              “No initial snapshot exists with these scopes” usually means the
              model needs different scopes; open <b>Scopes</b> and try again.
            </li>
            <li>
              Tabs in the same browser share one session. Use another browser
              or a private window for an independent simulation.
            </li>
            <li>
              When stepping, the solver may choose new environment-input values
              for the snapshot you step from, so the inputs shown for a
              snapshot are not always the ones its next step used.
            </li>
          </ul>
        </section>
      </div>
    </section>
  );
}
