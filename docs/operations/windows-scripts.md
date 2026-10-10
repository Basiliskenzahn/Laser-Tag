# Windows helper scripts

`scripts/` contains PowerShell helpers for hosting and developing on Windows. Run them from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\docker.ps1
```

| Script | What it does |
| --- | --- |
| `docker.ps1` | `docker compose up --build --force-recreate` from the repo root |
| `test.ps1` | **Both** suites: `docker compose run --rm tests` and `docker compose run --rm backend-tests` (see [Testing](../development/testing.md)) |
| `open-chrome.ps1` | Opens `http://localhost:8080/?debug` in Chrome or Edge |

Both Docker scripts dot-source `Resolve-Docker.ps1` first and stop with the Docker exit code on failure.

`test.ps1` used to run only the `tests` service, so a Windows contributor following the project's own script got 85 of 125 tests **and exit code 0** — the Python tests were never attempted and nothing said so. It now runs both, runs the second even if the first failed (so one run reports both), and exits non-zero if either failed. That aggregation is the reason it stays a script rather than a documented command.

### `Resolve-Docker.ps1`

A helper the other scripts dot-source. `Resolve-Docker` returns the path to `docker.exe`: from `PATH` if available, otherwise from the usual Docker Desktop install folders under Program Files and `%LOCALAPPDATA%`. If none exist, it throws a message suggesting `winget install -e --id Docker.DockerDesktop`.

This means the scripts work right after installing Docker Desktop, before a new terminal has picked up the updated `PATH`.

### `open-chrome.ps1`

Launches Chrome (from `.tools\chrome\` if present, otherwise an installed Chrome or Edge) with:

- a throwaway profile in `.tools\chrome-profile` (git-ignored), so it doesn't touch your normal browser profile;
- `--use-fake-ui-for-media-stream`, which auto-accepts the camera permission prompt (it still uses your real webcam);
- `--autoplay-policy=no-user-gesture-required`, so sound plays without a click.

Handy for repeatedly testing on the laptop with [debug mode](../development/debug-mode.md).

## One-time setup

Docker Desktop on Windows needs WSL 2. Run these as Administrator, once:

```powershell
dism /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
winget install -e --id Docker.DockerDesktop
```

They were scripts once; as four literal commands you can read them before running them.

From an **Administrator** PowerShell:

```powershell
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
wsl --set-default-version 2
winget install -e --id Docker.DockerDesktop
```

Then restart Windows, open Docker Desktop once and let it finish starting, and run `scripts\docker.ps1`.

If `docker` still isn't found in new terminals, either add `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` to your user `PATH`, or just use the scripts — `Resolve-Docker.ps1` finds `docker.exe` in that folder without any `PATH` change.

`dev.ps1` was also deleted. It and `docker.ps1` were byte-identical copies, so a fix to one silently missed the other; after that it became a one-line forwarder, which is a file to maintain for an alias. Use `docker.ps1`.
