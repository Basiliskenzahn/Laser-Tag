# Deployment and CI/CD

## Where it runs

The game is deployed to a hackathon VM and published through the event's reverse proxy:

| | |
| --- | --- |
| Public URL | https://22.hackathon.ethz.ch/ |
| SSH host | `22-direct.viscon-hackathon.ch`, port 22 |
| Checkout on the VM | `/home/viscon/Laser-Tag` |
| Port behind the proxy | 8080 (the `frontend` container's HTTP port) |

The reverse proxy terminates HTTPS with a trusted certificate, so players on the public URL don't see a certificate warning. Port 3443 and the self-signed certificate are only for LAN play.

## The deploy workflow

`.github/workflows/ci-cd-action.yml` defines two jobs on `ubuntu-latest`: `test`, then `deploy`.

**Triggers:**

| Event | `test` | `deploy` |
| --- | --- | --- |
| push to `dev` | yes | yes |
| pull request into `dev` | yes | no |
| `workflow_dispatch` | yes | yes |

### Why `push`, and not an `if:` on the pull request

The workflow used to trigger on `pull_request: branches: [dev], types: [closed]` with **no `if:` guard at all**, and its only action never referenced the PR, the merge commit or `$GITHUB_SHA`. So closing an abandoned PR — merged or not — redeployed whatever `origin/dev` happened to be at that moment, plus whatever uncommitted state the VM's tree was holding.

The obvious fix is `if: github.event.pull_request.merged == true`. Moving the deploy to `push: branches: [dev]` is better, because a push event to `dev` **only exists if something actually landed on `dev`**. The unmerged-close case stops being a case rather than becoming a case that is filtered out afterwards — there is no condition left to get wrong, and no second code path for a reviewer to check. It also fixes a gap the guard would not have: a direct push to `dev` previously never deployed at all.

`pull_request` is still a trigger, but only for `test`. That makes the suite a **pre-merge gate** that can be set as a required status check, rather than news that arrives after the merge.

### `test`

Runs both suites natively — `setup-node` + `npm test`, then `setup-python` + `pip install -r backend/requirements.txt` + `python -m unittest discover -s backend -p "test_*.py" -v`.

Deliberately **not** `docker compose run --rm tests`. On a runner that is strictly worse: it would `npm ci` ~180 MB of MediaPipe and ONNX Runtime that no test imports. A fresh checkout with no `node_modules` at all passes the full node suite.

Node is pinned to **22**, matching `package.json`'s `engines.node` and the compose `tests` service. This was meant to be 20, but node 20 cannot run this suite at all: `npm test` passes a quoted recursive glob (`"test/**/*.test.js"`) for the runner itself to expand, and node 20's test runner does not accept glob patterns — it exits with `Could not find 'test/**/*.test.js'` and runs nothing. Node 20 also reached end of life in April 2026. So the floor moved up instead of CI moving down. `test/deploy-robustness.test.js` asserts the three places agree with each other.

### `deploy`

Gated on `needs: test` and `if: github.event_name != 'pull_request'`, with `timeout-minutes`, `permissions: {}` (no job here needs a token) and `concurrency: {group: deploy-dev, cancel-in-progress: false}` — two deploys share one directory and one Docker daemon on the VM, so overlapping runs would build each other's code. Not `cancel-in-progress`, because killing an `ssh` mid-deploy would leave the VM in a state nobody chose.

The remote command is:

```bash
cd /home/viscon/Laser-Tag \
  && git fetch --prune origin \
  && git checkout -f -B dev "$GITHUB_SHA" \
  && git clean -fd \
  && git --no-pager log --oneline -1 \
  && docker compose up --build -d --remove-orphans \
  && docker compose ps \
  && docker image prune -f
```

**Why not `git pull`.** `git pull` on a live server can deploy a tree that exists in no commit. Three divergent cases:

- a dirty tree that *conflicts* aborts loudly — the good case;
- a dirty tree that does **not** conflict merges around the local edits and then builds `origin/dev` plus someone's leftover debugging, silently, reported as a green check;
- a non-fast-forward produces an unreviewed merge commit that exists only on the VM, which makes every subsequent pull more likely to diverge again.

`checkout -f -B dev <sha>` is pinned to the commit that triggered the run, so the deploy is reproducible and two racing deploys cannot land each other's code.

**Why `git clean -fd` and not `-fdx`.** `-fd` removes untracked files and directories; it does **not** touch ignored files, which needs `-x`. Everything the VM legitimately keeps outside git is ignored by `.gitignore` — `.env*`, `*.pem`/`*.key`/`*.crt`, `node_modules/`, `__pycache__/` — so `-x` would delete precisely the files a human put there on purpose. The TLS certificate is not at risk either way: it lives in the `certs` Docker volume, not in the tree.

What `-fd` *can* still destroy is untracked-and-not-ignored content. The realistic one is a hand-written **`docker-compose.override.yml`**, which Compose merges automatically and which no `.gitignore` rule covers — if anyone has put one on the VM to pin `CERT_HOSTS` or a port, this deploy will delete it and silently change the deployment. Put such settings in the committed compose file instead. (This was checked by reading `.gitignore`, `docker-compose.yml` and the Dockerfiles: there are no bind mounts in the runtime services and nothing reads an env file. It was **not** checked against the live VM, which this environment has no access to.)

**Why prune.** Each deploy builds new images and leaves the previous ones dangling; the frontend image carries ~18 MB of models plus ~170 MB of vendored runtime. Nothing pruned anywhere, and the eventual out-of-disk presents as a mysterious red deploy rather than a disk alarm. `docker image prune -f` removes only *dangling* images, so it cannot touch anything a running container uses; `-a` is deliberately not used. Build cache is still not pruned — if disk becomes a problem again, `docker builder prune` is the next lever.

Containers are rebuilt and replaced. Since all game state is in memory, **any running games are lost on deploy**. The `certs` volume is kept.

### Required secrets

| Secret | Contents |
| --- | --- |
| `SSH_USER` | User on the VM that owns the checkout and can run Docker |
| `SSH_PRIVATE_KEY` | Private key whose public half is in that user's `~/.ssh/authorized_keys` |

Set them under *Settings → Secrets and variables → Actions*.

### Things to know

- **A deploy now waits for the backend to be healthy.** `depends_on: condition: service_healthy` means `docker compose up -d` starts nginx only once aiohttp answers, so a deploy takes a few seconds longer and no longer has a window where `/api/` and `/events/` both return 502. See [Restart policies and readiness](docker.md#restart-policies-and-readiness).
- **The deploy does not fail on an unhealthy container.** `docker compose up -d` is not run with `--wait`, so the step prints `docker compose ps` for visibility but reports success as long as the containers started. `--wait` is the natural follow-up, and the reason it is not here yet is honest: the healthchecks have never been observed running in the real images (no Docker daemon was available when they were written), and a healthcheck that is subtly wrong under `--wait` turns *every* deploy red. Add it once you have watched both services report healthy once.
- `ssh-keyscan` trusts whatever key the host presents at deploy time. Pinning the host key in a secret would be stricter.
- **A redeploy reaches phones immediately for the client, and within ~5 minutes for a model.** The app shell is served `no-store`, so a new `app.js` takes effect on the next page load. The model files under `frontend/public/models/` are cached for 300 s with an ETag, so a replaced model propagates on its own shortly after the containers come back — nobody has to clear site data. The vendored MediaPipe/ONNX runtimes are cached for a day and only change when `package-lock.json` does. See [the caching policy](docker.md#caching-policy-and-why-the-app-shell-is-the-exception).
- **Replacing a model means replacing the file, not renaming it.** The caching policy is built around that: it revalidates rather than declaring the files `immutable`, so the fixed URLs stay safe. If you ever add filename hashing, revisit it.

## Deploying somewhere else

Any machine with Docker Compose works:

```bash
git clone <repo> && cd Laser-Tag
docker compose up --build -d
```

Then either:

- put a reverse proxy with a real certificate in front of port **8080** (keep proxy buffering off, compression off and a long read timeout for `/events/`; polls are held for up to 20 s, and compressing an SSE stream means buffering it). Let the cache headers the container already sets pass through rather than overriding them — see [the caching policy](docker.md#caching-policy-and-why-the-app-shell-is-the-exception); or
- let players use port **3443** directly and accept the self-signed certificate.

The server keeps all state in memory in a single process, so run exactly one `backend` container.
