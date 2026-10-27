# Contributing

Agent Reliability Lab is a measurement tool. Changes should make a result easier to reproduce or harder to misread.

## Setup

```bash
git clone <this repository>
cd agent-reliability-lab
npm install
npm test
```

Node.js 22.18 or newer is required. The runtime has no dependencies. `npm install` only fetches TypeScript so `npm run typecheck` can run.

## Making a change

1. Add or update a test that fails for the behavior you are fixing.
2. Keep benchmark logic in `src/` independent of `dashboard/`.
3. Do not treat a missing metric as zero or as a success.
4. If you change the synthetic generator, bump `GENERATOR_VERSION` or `DATASET_VERSION` in `src/version.ts` and regenerate `datasets/baseline.json` with the recorded seed.
5. If you change a metric formula, bump `METRICS_VERSION` and update `src/metrics/definitions.ts` and the README. The definitions and the calculator must describe the same rule.
6. Regenerate `examples/mixed-report.md` and `examples/mixed-report.json` from the scripted mixed profile when task outcomes change. Do not hand-edit scores.

## Checks

```bash
npm run typecheck
npm test
node src/cli.ts run --dataset datasets/baseline.json --agent scripted --profile fixtures/scripted-mixed.json
```

Tests must not call a live model. A test that does needs `ARL_LIVE_OPENAI=1` and should be skipped otherwise. None of the current tests do that.

## Safety

Do not add a tool that shells out, fetches arbitrary URLs, or executes model output. Task text is data. Provider credentials stay in environment variables and must not be written to runs, reports, or the dashboard.
