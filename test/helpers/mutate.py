#!/usr/bin/env python3
"""Mutation runner: break one behaviour, confirm the test that guards it fails, restore.

Usage: python3 test/helpers/mutate.py [id ...]   (no ids = all)
Each mutation is (id, file, find, replace, test file, what it breaks).

A test nobody has watched fail does not count, so this is the record of having watched them. It
anchors on exact source text: if a mutation reports SKIPPED, that text has moved and the mutation
needs re-aiming, not deleting. Every one of these must report FAILED - except M1b, which documents
a deliberate redundancy (two independent guards stop a stale reconnect, so removing one of them
alone is expected to leave the suite green).
"""
import subprocess
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]

NET = "frontend/public/net.js"
TRANSPORT = "frontend/public/transport.js"
LOBBY = "frontend/public/screens/lobby.js"
JOIN = "frontend/public/screens/join.js"
MOTION = "frontend/public/motion-identity.js"
SENSOR = "frontend/public/motion/sensor.js"
APPEARANCE = "frontend/public/appearance-identity.js"

CONN = "test/connection-lifecycle.test.js"
TRANS = "test/transport-lifecycle.test.js"
MOT = "test/motion-teardown.test.js"

MUTATIONS = [
    (
        "M1-uncancellable-timer",
        NET,
        """      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        // Belt and braces behind cancelReconnect(): every "we are leaving" path nulls state.conn,
        // so a retry that outlives one has nothing to reconnect for.
        if (state.conn !== conn) return;
        connect();
      }, RECONNECT_DELAY_MS);""",
        "      setTimeout(connect, RECONNECT_DELAY_MS);",
        CONN,
        "bug 1: the reconnect timer is cancellable at all",
    ),
    (
        "M1b-no-second-guard",
        NET,
        "        if (state.conn !== conn) return;\n        connect();",
        "        connect();",
        CONN,
        "bug 1: only the belt-and-braces guard, cancellation left in place",
    ),
    (
        "M1c-leaveLobby-does-not-cancel",
        LOBBY,
        "  leaveRoom({ notify: true });",
        "  state.conn?.close({ notify: true });\n  state.conn = null;",
        CONN,
        "bug 1: the call site stops cancelling",
    ),
    (
        "M2a-send-failure-returns-undefined",
        TRANSPORT,
        "        if (attempt === sendAttempts) return false;",
        "        if (attempt === sendAttempts) return undefined;",
        TRANS,
        "bug 2: a lost message is not reported as false",
    ),
    (
        "M2b-send-failure-closes-connection",
        TRANSPORT,
        "        if (attempt === sendAttempts) return false;",
        "        if (attempt === sendAttempts) {\n          fail();\n          return false;\n        }",
        TRANS,
        "bug 2: a failed send tears the connection down again",
    ),
    (
        "M2c-no-retry",
        TRANSPORT,
        "const SEND_ATTEMPTS = 3; // the first try plus two retries",
        "const SEND_ATTEMPTS = 1;",
        TRANS,
        "bug 2: one transient error is no longer retried",
    ),
    (
        "M3-dispatch-inside-the-try",
        TRANSPORT,
        "          dispatch(msg);",
        "          onMessage(msg);",
        TRANS,
        "bug 3: a handler throw reaches the poll loop's catch",
    ),
    (
        "M4-enter-game-from-lobby-only",
        NET,
        "    if (state.mode === 'scan') cancelScan();\n    if (state.mode === 'lobby') enterGame();",
        "    if (state.mode === 'lobby') enterGame();",
        CONN,
        "bug 4: a snapshot arriving during a scan is dropped",
    ),
    (
        "M5a-launch-ignores-the-connection",
        LOBBY,
        "    !state.connected || !state.game ||",
        "    !state.game ||",
        CONN,
        "bug 5: Launch stops reading the connection",
    ),
    (
        "M5b-no-lobby-rerender",
        NET,
        "  state.bannerOverride = text;\n"
        "  // renderLobby is the only writer of the Launch button's disabled state, so a connection coming\n"
        "  // or going has to re-render the lobby as well as the HUD. Without this, Launch stayed enabled\n"
        "  // through a drop: tapping it set an optimistic 3 s countdown and moved the player to the game\n"
        "  // screen - which has no leave control - while the `start` went nowhere.\n"
        "  if (state.mode === 'lobby') renderLobby();",
        "  state.bannerOverride = text;",
        CONN,
        "bug 5: the lobby is not re-rendered when the connection changes",
    ),
    (
        "M6-clear-the-snapshot-on-every-blip",
        NET,
        "      state.connected = false;\n      if (!opened) state.failedConnects++;",
        "      state.connected = false;\n      state.game = null;\n      if (!opened) state.failedConnects++;",
        CONN,
        "bug 6: a blip blanks the round again",
    ),
    (
        "M7-no-catch-around-startLobby",
        JOIN,
        "  try {\n    await startLobby(options);\n  } catch (err) {",
        "  if (true) {\n    await startLobby(options);\n  } else if (false) {\n    const err = null;",
        CONN,
        "bug 7: a throw latches state.startingLobby",
    ),
    (
        "M8a-no-pagehide-listener",
        NET,
        "if (typeof window !== 'undefined') window.addEventListener('pagehide', notifyLeaving);",
        "",
        CONN,
        "bug 8: the tab-close notification is not wired up",
    ),
    (
        "M8b-goodbye-twice",
        TRANSPORT,
        "    if (notified || !token) return;\n    notified = true;",
        "    if (!token) return;",
        TRANS,
        "bug 8: the goodbye is sent more than once",
    ),
    (
        "M9a-interval-never-cleared",
        MOTION,
        "  if (flushTimer !== null) {\n    clearInterval(flushTimer);\n    flushTimer = null;\n  }",
        "",
        MOT,
        "bug 9: the flush interval leaks",
    ),
    (
        "M9b-sensor-never-stopped",
        MOTION,
        "  sensor?.stop();\n  sensor = null;",
        "  sensor = null;",
        MOT,
        "bug 9: the devicemotion listener leaks",
    ),
    (
        "M9c-remote-activity-never-cleared",
        MOTION,
        "  remoteActivity.clear();",
        "",
        MOT,
        "bug 9: player ids accumulate across rooms",
    ),
    (
        "M9d-no-permission-generation-guard",
        MOTION,
        "    if (!granted || attempt !== generation) return;",
        "    if (!granted) return;",
        MOT,
        "bug 9: a sensor starts behind a player who already left",
    ),
    (
        "M9e-stopped-sensor-keeps-its-bin",
        SENSOR,
        "    this.bin = null; // a stopped sensor must not flush a half-filled bin into `outgoing`",
        "",
        MOT,
        "bug 9: a stopped sensor can still flush a bin",
    ),
    (
        "M9f-asymmetric-seam",
        APPEARANCE,
        "  stop() {}, // nothing to tear down: appearance alone holds no sensor and no per-room state",
        "",
        CONN,
        "bug 9: the identity seam loses stop() on the appearance provider",
    ),
]


def run(mutation):
    mid, rel, find, replace, test_file, what = mutation
    path = ROOT / rel
    original = path.read_text()
    if original.count(find) != 1:
        return mid, "SKIPPED", f"the target text appears {original.count(find)} times in {rel}", what
    path.write_text(original.replace(find, replace))
    try:
        try:
            proc = subprocess.run(
                ["node", "--test", test_file],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=120,
            )
        except subprocess.TimeoutExpired:
            return mid, "HUNG", "the test process never exited (a leaked timer holds it open)", what
        failures = [
            line.strip()
            for line in proc.stdout.splitlines()
            if line.strip().startswith("not ok")
        ]
        verdict = "FAILED (good)" if failures else "STILL PASSED"
        detail = "; ".join(f.split(" - ", 1)[-1] for f in failures) or "no test failed"
    finally:
        path.write_text(original)
    return mid, verdict, detail, what


if __name__ == "__main__":
    wanted = set(sys.argv[1:])
    for mutation in MUTATIONS:
        if wanted and mutation[0] not in wanted:
            continue
        mid, verdict, detail, what = run(mutation)
        print(f"{mid:40s} {verdict:16s} {what}\n{'':40s} -> {detail}")
