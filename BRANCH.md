# `luxkaiwalker/prune-repo`

**Owner: LuxKaiwalker.** A working branch off `luxkaiwalker-dev`, not a deploy target.

## What this branch is

An audit and prune. The repository had grown a test suite larger than the application it tests,
an archive directory of code already removed from the build, a synthetic measurement harness
nobody runs, and seven documentation files that recorded how one session went rather than what it
concluded. This branch deletes those.

It changes no application code. `frontend/public/` and `backend/` are untouched here.

Nothing lands on `dev` until both suites pass together:

```bash
docker compose run --rm tests          # JS
docker compose run --rm backend-tests  # Python
```

## What is still open

Project-level decisions and risks live in [`docs/open-items.md`](docs/open-items.md) - the CI test
gate, the `MIN_SHAPE_SCORE` / `EVIDENCE_MIN_PART` recalibration, whether MobileNet's 4 MB stays,
and the measurements nobody has taken on a real phone. That file is the one to read and the one to
edit when an item is resolved.

## Held back from the PR into `dev`

**The CI workflow.** `.github/workflows/ci-cd-action.yml` is byte-identical to `dev` here -
reverted on purpose, so the pull request carries **no CI diff at all**. Deploy behaviour is shared
infrastructure that affects everyone, and bundling it with a prune would mean one review covering
both.

The worked version is preserved on **`luxkaiwalker/deploy-robustness`** and is worth its own PR.
It moves the trigger from `pull_request: types: [closed]` to `push: branches: [dev]` (so a PR
closed *unmerged* stops being a case rather than being filtered out by an `if:`), adds a `test`
job both triggers run with `deploy: needs: test`, pins the deployed tree to `${{ github.sha }}`
instead of `git pull`, and adds `concurrency`, `timeout-minutes`, `permissions: {}` and an image
prune. `docs/operations/deployment.md` documents today's behaviour, including the unmerged-close
hazard, and points at that branch.

Five tests that pinned the new workflow were removed with it; a sixth kept its
`package.json` ↔ compose half and dropped its `node-version:` arm, with a comment saying to
restore it if that branch lands.
