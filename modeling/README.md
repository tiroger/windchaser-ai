# Modeling

Documented ML experiments on WindChaser's own data, as [marimo](https://marimo.io)
notebooks. Each notebook states the problem, the data, the method, the results,
what they mean, the limitations and the next steps. Prose that depends on a
result is generated from it (`mo.md(f"…")`), so conclusions rewrite themselves,
in either direction, when the data or the model changes.

## Experiments

| # | Notebook | Question | Finding (at the time of writing) |
|---|---|---|---|
| 01 | [`01_physics_residual_model.py`](notebooks/01_physics_residual_model.py) | Can a learned model correct the physics segment-time prediction, and can conformal methods replace the hand-made σ? | No point correction beats production on future efforts (best: a constant shift, CI crossing zero). Production's σ under-covers (about 70% at a stated 80%); re-sizing it conformally gives calibrated 80% and 90% intervals. Ship the interval fix, not a model. |
| 02 | [`02_durability_and_pacing.py`](notebooks/02_durability_and_pacing.py) | How much does sustainable power fall with work done, and what does variable pacing gain over the planner's constant power? | The 20-minute power ceiling falls by roughly a tenth to a sixth after 1,500 kJ; a durability envelope beats a flat one on held-out rides. Optimised pacing at the same average power saves a few percent on hilly routes, mostly on climbs. Replaying real rides confirms the physics' pacing sensitivity, slightly overstated. |

The table summarises; the notebooks hold the numbers, computed at run time.

## Running

Python is managed with uv. The modeling dependencies are an optional group:

```bash
uv sync --group modeling                  # or --all-groups, as CI does
export APP_DATA_BUCKET=<the app data bucket>
export AWS_PROFILE=<a profile that can read it>  AWS_REGION=us-east-1

uv run marimo edit modeling/notebooks/01_physics_residual_model.py
uv run marimo edit modeling/notebooks/02_durability_and_pacing.py
```

Headless, end to end (exports stay outside the repository or in the ignored
`modeling/exports/`):

```bash
uv run marimo export html modeling/notebooks/01_physics_residual_model.py -o /tmp/01.html
uv run marimo check modeling/notebooks/*.py
uv run python scripts/test_modeling.py     # shared code, synthetic data
```

Notebook 01 rebuilds the production calibration once per quarter of history
(about fifty rebuilds); the first run takes a minute on several cores and is
cached under `modeling/.cache/baseline/` after that. Notebook 02 takes a few
minutes, most of it the pacing survey over every saved route.

## Data

Read-only, from the same S3 objects the web app and workers use:

| Object | Used for |
|---|---|
| `efforts.json` | segment efforts with ERA5 weather; segments with geometry and elevation |
| `calibration.json` | the shipped rider model (CP, W′, grade term, fitted mass and CdA) |
| `activities.json` | every activity; training load. Units: miles, **hours**, feet, mph |
| `streams-index.json` | per-ride 1 Hz power bests, NP, exercise load |
| `streams/{id}.json` | ≤ 1,200 samples per ride, picked (not averaged) from 1 Hz |
| `saved-routes.json`, `saved-routes/{id}.json` | route profiles for the pacing survey |
| `settings.json` | athlete weight |

`windchaser_modeling.data.sync()` downloads into `modeling/.cache/s3/` and
records each object's ETag and modification time; later runs make no network
call unless asked to refresh. Nothing is ever written to S3, and nothing calls
Strava.

**Times.** Efforts carry UTC; activities carry wall-clock time with a fake
`Z`. `features.align_efforts` recovers each ride's UTC offset from where its
stream passes the segment start, then learns each region's IANA zone from those
offsets to cover rides without a stream.

## Layout

```text
modeling/
  README.md
  windchaser_modeling/     shared code, unit-tested on synthetic data
    data.py                S3 loaders, cache, SI frames, time parsing
    features.py            training load, ride alignment, work before an effort,
                           weather and segment features, route sections (port of
                           the planner's buildSections), MMP by work done, loops
    evaluation.py          production replay (rolling-origin calibration rebuilds),
                           physics.ts σ, metrics, bootstrap, conformal, folds
    residual.py            experiment 01: models, intervals, importance
    durability.py          experiment 02: envelopes, cohort, CP and W′
    pacing.py              experiment 02: W′ balance, speed tables, optimiser
    charts.py              Altair theme from the site's design tokens
  notebooks/
    01_physics_residual_model.py
    02_durability_and_pacing.py
```

The two experiment modules (`residual.py`, `durability.py`, `pacing.py`) sit
beside the shared ones rather than inside the notebooks so that the parts a
conclusion depends on are tested (`scripts/test_modeling.py`), and the notebooks
read as analysis rather than plumbing. Physics, the rider model and calibration
are imported from `packages/cycling-analytics`, never reimplemented; the
TypeScript-only pieces the experiments need (the σ in `physics.ts`, the
planner's sectioning) are ported with a pointer to their source.

## Conventions

* **The repository is public.** Notebooks are code only. Data, caches,
  exports, HTML and fitted artefacts stay in ignored paths
  (`modeling/.cache/`, `modeling/exports/`, `__marimo__/`). No personal number
  is written into prose; every number is computed.
* **Time-forward evaluation.** Anything that predicts the future is scored on
  the future: rolling origins, expanding windows, calibration slices that
  precede their test data.
* **Baselines are production.** A model is compared with what the app does
  today, replayed honestly, and with the simplest alternative (a constant),
  not with a straw man.
* **Say no when the answer is no.** Decisions are computed from confidence
  intervals and fold-by-fold wins, and the prose follows them.
* **Reproducible.** Seeds are fixed; each notebook prints its data snapshot
  times and row counts.
* **CI** compiles everything under `modeling/` and runs
  `scripts/test_modeling.py`. The notebooks themselves need private data and
  are not executed in CI.
