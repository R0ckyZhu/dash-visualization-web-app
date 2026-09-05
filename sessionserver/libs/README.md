# dashplus.jar — prebuilt engine

`dashplus.jar` is the Dash+ engine (parser, DashToAlloy translator, Alloy
interface) bundled with all of its runtime dependencies: the Alloy distribution,
gson, guava, and the antlr runtime. The session server compiles and runs against
this jar alone; the dashplus **source tree is not part of this repository**.

It is checked in deliberately — without it the repository cannot be built.

## Provenance

Built from [WatForm/dashplus](https://github.com/WatForm/dashplus) with that
project's own `releaseJar` task (output `app/build/libs/watform-dashplus.jar`),
from the source that was vendored in this repo up to commit `1dc4246`.

## Refreshing it

Upstream `master` is **not** always buildable — at the time of writing it
carries unresolved merge-conflict markers in
`alloytotla/AlloyToTla.java` (introduced by commit `317c8230`, "merge; TLA needs
to be fixed"), so `releaseJar` fails there. Check out a known-good commit rather
than assuming `master` builds.

```sh
git clone https://github.com/WatForm/dashplus.git /tmp/dashplus
cd /tmp/dashplus
git checkout <known-good-commit>
./gradlew releaseJar
cp app/build/libs/watform-dashplus.jar <this-repo>/sessionserver/libs/dashplus.jar
```

Then rebuild the session server:

```sh
cd sessionserver && ./gradlew sessionServerJar
```

If dashplus changed a public API the session server uses, it surfaces there as a
compile error. `CommandRouter` depends on: `parser.Parser`,
`dashmodel.DashModel`/`DashParam`, `dashtoalloy.DashToAlloy`/`BaseD2A`,
`alloymodel.AlloyModel`, `alloyinterface.AlloyInterface`/`Solution`,
`alloyast.AlloyQtEnum`, `alloyast.expr.AlloyExpr`, `dashast.dashref.DashRef`,
and `utils.Reporter`.
