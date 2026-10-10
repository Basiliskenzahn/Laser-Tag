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

`.github/workflows/ci-cd-action.yml` defines one job, `build`, on `ubuntu-latest`.

**Triggers:**

- a pull request into `main` being **closed**;
- a manual run from the Actions tab (`workflow_dispatch`).

**Steps:**

1. Check out the repository.
2. Write the `SSH_PRIVATE_KEY` secret to `~/.ssh/deploy_key` and add the host to `known_hosts` with `ssh-keyscan`.
3. SSH to the VM as `SSH_USER` and run:

   ```bash
   cd /home/viscon/Laser-Tag && git checkout main && git pull && docker compose up --build -d
   ```

Containers are rebuilt and replaced. Since all game state is in memory, **any running games are lost on deploy**. The `certs` volume is kept.

### Required secrets

| Secret | Contents |
| --- | --- |
| `SSH_USER` | User on the VM that owns the checkout and can run Docker |
| `SSH_PRIVATE_KEY` | Private key whose public half is in that user's `~/.ssh/authorized_keys` |

Set them under *Settings → Secrets and variables → Actions*.

### Things to know

- **Closing a PR without merging also triggers a deploy.** The workflow listens for `closed`, not specifically merged. It's harmless, since the VM always pulls `main`, but it does restart the containers. To deploy only on merge, add `if: github.event.pull_request.merged == true || github.event_name == 'workflow_dispatch'` to the job.
- **Direct pushes to `main` don't deploy.** Run the workflow manually afterwards.
- **No tests run in CI.** The job deploys whatever is on `main`. Run `docker compose run --rm tests` before merging. See [Testing](../development/testing.md).
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
