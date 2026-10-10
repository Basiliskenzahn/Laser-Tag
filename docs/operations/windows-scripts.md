# Windows helper scripts

`scripts/` contains PowerShell helpers for hosting and developing on Windows. Run them from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\docker.ps1
```

## Everyday scripts

| Script | What it does |
| --- | --- |
| `docker.ps1` | `docker compose up --build --force-recreate` from the repo root |
| `dev.ps1` | Forwards to `docker.ps1` |
| `test.ps1` | **Both** suites: `docker compose run --rm tests` and `docker compose run --rm backend-tests` (see [Testing](../development/testing.md)) |
| `open-chrome.ps1` | Opens `http://localhost:8080/?debug` in Chrome or Edge |

All three Docker scripts load `Resolve-Docker.ps1` first and stop with the Docker exit code on failure.

`dev.ps1` and `docker.ps1` used to be byte-identical copies (`diff` was empty), so a fix to one silently missed the other. `dev.ps1` now forwards to `docker.ps1`; both names keep working and there is one implementation.

`test.ps1` used to run only the `tests` service, so a Windows contributor following the project's own script got 85 of 125 tests **and exit code 0** — the 40 Python tests were never attempted and nothing said so. It now runs both, runs the second even if the first failed (so one run reports both), and exits non-zero if either failed.

### `Resolve-Docker.ps1`

A helper the other scripts dot-source. `Resolve-Docker` returns the path to `docker.exe`: from `PATH` if available, otherwise from the usual Docker Desktop install folders under Program Files and `%LOCALAPPDATA%`. If none exist, it throws a message suggesting `winget install -e --id Docker.DockerDesktop`.

This means the scripts work right after installing Docker Desktop, before a new terminal has picked up the updated `PATH`.

### `open-chrome.ps1`

Launches Chrome (from `.tools\chrome\` if present, otherwise an installed Chrome or Edge) with:

- a throwaway profile in `.tools\chrome-profile` (git-ignored), so it doesn't touch your normal browser profile;
- `--use-fake-ui-for-media-stream`, which auto-accepts the camera permission prompt (it still uses your real webcam);
- `--autoplay-policy=no-user-gesture-required`, so sound plays without a click.

Handy for repeatedly testing on the laptop with [debug mode](../development/debug-mode.md).

## One-time setup scripts

Docker Desktop on Windows needs WSL 2. These scripts set that up.

| Script | Admin? | What it does |
| --- | --- | --- |
| `install-docker-prereqs.ps1` | Elevates itself | Enables the `Microsoft-Windows-Subsystem-Linux` and `VirtualMachinePlatform` features with DISM, then installs or repairs Docker Desktop with `winget` |
| `install-wsl-admin.ps1` | Run it from an admin PowerShell | Enables the same two features and sets WSL 2 as the default version |
| `add-docker-path.ps1` | No | Adds `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` to your **user** `PATH` if it isn't already there |

Typical first-time order:

1. `install-docker-prereqs.ps1`
2. Restart Windows.
3. Open Docker Desktop once and let it finish starting.
4. `add-docker-path.ps1` if `docker` still isn't found in new terminals.
5. `docker.ps1`
