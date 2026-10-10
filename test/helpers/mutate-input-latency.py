#!/usr/bin/env python3
"""Mutation runner for the input-latency work: break one behaviour, confirm the test that guards
it fails, restore.

Usage: python3 test/helpers/mutate-input-latency.py [id ...]   (no ids = all)
Each mutation is (id, file, find, replace, test file, what it breaks).

Same shape and same purpose as test/helpers/mutate.py, which covers the connection and motion
work. A test nobody has watched fail does not count, so this is the record of having watched
them. It anchors on exact source text: if a mutation reports SKIPPED, that text has moved and the
mutation needs re-aiming, not deleting. Every one of these must report FAILED - except the one
id ending in `-redundant`, which documents a deliberate belt-and-braces pair (the feature check
and the try/catch in inputPending() each independently handle a browser without
navigator.scheduling, so removing one alone is expected to leave the suite green; G5b removes
both, and that must fail).
"""
import subprocess
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]

LATENCY = "frontend/public/input-latency.js"
GAME = "frontend/public/screens/game.js"
APP = "frontend/public/app.js"

UNIT = "test/input-latency.test.js"
SHOT = "test/shot-latency.test.js"
DEBUGGED = "test/input-latency-debug.test.js"
COST = "test/input-latency-cost.test.js"

MUTATIONS = [
    # ---- the readout's guards on event.timeStamp ----
    (
        "L1-no-epoch-guard",
        LATENCY,
        "  if (wait < -NEGATIVE_TOLERANCE_MS) return null;",
        "",
        UNIT,
        "a Unix-epoch timeStamp is printed as a delivery wait",
    ),
    (
        "L2-no-zero-guard",
        LATENCY,
        "  if (eventTimeStamp === 0) return null;",
        "",
        UNIT,
        "a stamp of 0 reports the age of the page as input lag",
    ),
    (
        "L3-no-upper-bound",
        LATENCY,
        "  if (wait > MAX_PLAUSIBLE_WAIT_MS) return null;",
        "",
        UNIT,
        "a stamp from another time origin is printed",
    ),
    (
        "L4-coarsening-not-clamped",
        LATENCY,
        "  return Math.max(0, wait);",
        "  return wait;",
        UNIT,
        "clock coarsening reports a negative delivery wait",
    ),
    # ---- the readout's windows and figures ----
    (
        "L5-hidden-tab-counted",
        LATENCY,
        "  if (gap <= 0 || gap > MAX_PLAUSIBLE_BLOCK_MS) return stats;",
        "  if (gap <= 0) return stats;",
        UNIT,
        "a hidden tab is reported as the main thread blocking",
    ),
    (
        "L6-stale-window-resurfaces",
        LATENCY,
        "    stats.blockPrevious = elapsed >= BLOCK_WINDOW_MS * 2 ? 0 : stats.blockCurrent;",
        "    stats.blockPrevious = stats.blockCurrent;",
        UNIT,
        "a blocking chunk from long ago never ages out",
    ),
    (
        "L7-mean-only",
        LATENCY,
        "  return `${ms(total / values.length)}/${ms(Math.max(...values))}`;",
        "  return `${ms(total / values.length)}/${ms(total / values.length)}`;",
        UNIT,
        "the worst case is hidden behind the mean",
    ),
    (
        "L8-samples-never-trimmed",
        LATENCY,
        "  if (stats.shots.length > SHOT_SAMPLES) stats.shots.splice(0, stats.shots.length - SHOT_SAMPLES);",
        "",
        UNIT,
        "one bad shot stays in the reading for the whole round",
    ),
    (
        "L9-dashes-for-nothing",
        LATENCY,
        "  if (!shots.length) return block > 0 ? `Input block ${ms(block)}` : '';",
        "  if (!shots.length) return `Input tap -/- shot -/- n0`;",
        UNIT,
        "no measurement yet reads like a measurement of zero",
    ),
    (
        "L10-backwards-resolve-accepted",
        LATENCY,
        "  const resolve = Number.isFinite(entryAt) && Number.isFinite(resolvedAt) && resolvedAt >= entryAt ? resolvedAt - entryAt : null;",
        "  const resolve = resolvedAt - entryAt;",
        UNIT,
        "a resolve time before the entry time is printed as a negative span",
    ),
    # ---- the forced detection stays off the shot path ----
    (
        "G1-forced-refresh-restored",
        GAME,
        "  const hit = targetUnderCrosshair(video.videoWidth / 2, video.videoHeight / 2);",
        "  if (performance.now() - state.lastGameDetectAt > 90) {\n"
        "    refreshGameDetection();\n"
        "  }\n"
        "  const hit = targetUnderCrosshair(video.videoWidth / 2, video.videoHeight / 2);",
        SHOT,
        "fire() forces a synchronous detection again",
    ),
    (
        "G1b-forced-refresh-cost-tripwire",
        GAME,
        "  const hit = targetUnderCrosshair(video.videoWidth / 2, video.videoHeight / 2);",
        "  if (performance.now() - state.lastGameDetectAt > 90) {\n"
        "    refreshGameDetection();\n"
        "  }\n"
        "  const hit = targetUnderCrosshair(video.videoWidth / 2, video.videoHeight / 2);",
        COST,
        "the structural tripwire for a detection back on the shot path",
    ),
    (
        "G2-raw-box-not-projected",
        GAME,
        "    const box = liveBox(t, now);\n    if (contains(headBox(box), px, py))",
        "    const box = t.box;\n    if (contains(headBox(box), px, py))",
        SHOT,
        "the shot resolves against the last detected box, not the projected one",
    ),
    # ---- the tap gets in front of the inference ----
    (
        "G3-no-input-deferral",
        GAME,
        "if (now - state.lastGameDetectAt >= gameDetectInterval(now) && !deferDetectionForInput(now)) {",
        "if (now - state.lastGameDetectAt >= gameDetectInterval(now)) {",
        SHOT,
        "the loop starts an inference with a tap already pending",
    ),
    (
        "G4-unbounded-deferral",
        GAME,
        "  if (now - detectDueSince >= DETECT_INPUT_DEFER_MAX_MS) {\n"
        "    detectDueSince = 0;\n"
        "    return false;\n"
        "  }\n"
        "  return true;",
        "  return true;",
        SHOT,
        "sustained input starves detection indefinitely",
    ),
    (
        "G5-no-feature-detection-redundant",
        GAME,
        "  if (typeof scheduling?.isInputPending !== 'function') return false;",
        "",
        SHOT,
        "the feature check alone; the try/catch below still covers it, so this is expected to pass",
    ),
    (
        "G5b-no-guard-at-all",
        GAME,
        "  if (typeof scheduling?.isInputPending !== 'function') return false;\n"
        "  try {\n"
        "    return scheduling.isInputPending() === true;\n"
        "  } catch {\n"
        "    return false;\n"
        "  }",
        "  return scheduling.isInputPending() === true;",
        SHOT,
        "a browser without navigator.scheduling breaks the frame loop",
    ),
    (
        "G6-no-try-catch",
        GAME,
        "  try {\n    return scheduling.isInputPending() === true;\n  } catch {\n    return false;\n  }",
        "  return scheduling.isInputPending() === true;",
        SHOT,
        "an isInputPending that throws takes detection down with it",
    ),
    (
        "G7-deferral-clock-never-cleared",
        GAME,
        "  if (!pending()) {\n    detectDueSince = 0;\n    return false;\n  }",
        "  if (!pending()) {\n    return false;\n  }",
        SHOT,
        "brief taps accumulate towards the starvation bound",
    ),
    # ---- the instrumentation measures what it says it measures ----
    (
        "G8-resolve-not-a-span",
        GAME,
        "    recordShot(inputStats, { eventTimeStamp: firedAt, entryAt: now, resolvedAt: performance.now() });",
        "    recordShot(inputStats, { eventTimeStamp: firedAt, entryAt: now, resolvedAt: now });",
        DEBUGGED,
        "the shot figure is a hard-coded zero rather than a span over fire()",
    ),
    (
        "G9-tap-measured-from-the-handler",
        GAME,
        "    recordShot(inputStats, { eventTimeStamp: firedAt, entryAt: now, resolvedAt: performance.now() });",
        "    recordShot(inputStats, { eventTimeStamp: now, entryAt: now, resolvedAt: performance.now() });",
        DEBUGGED,
        "the delivery wait is measured from the handler, so it is always zero",
    ),
    (
        "G10-block-not-a-frame-gap",
        GAME,
        "    recordBlock(inputStats, now - lastDebugFrameAt, now);",
        "    recordBlock(inputStats, 16, now);",
        DEBUGGED,
        "the blocking-chunk figure is not the real frame gap",
    ),
    (
        "G11-line-not-in-the-overlay",
        GAME,
        "      (inputLine ? `\\n${inputLine}` : '') +",
        "",
        DEBUGGED,
        "the readout is computed but never shown",
    ),
    # ---- and costs nothing without ?debug ----
    (
        "G12-shot-measured-unconditionally",
        GAME,
        "  if (DEBUG) {\n"
        "    recordShot(inputStats, { eventTimeStamp: firedAt, entryAt: now, resolvedAt: performance.now() });\n"
        "  }",
        "  recordShot(inputStats, { eventTimeStamp: firedAt, entryAt: now, resolvedAt: performance.now() });",
        COST,
        "the shot sample is built on every shot, ?debug or not",
    ),
    (
        "G13-stats-always-allocated",
        GAME,
        "const inputStats = DEBUG ? emptyInputStats() : null;",
        "const inputStats = emptyInputStats();",
        COST,
        "the samples object is allocated on a normal load",
    ),
    (
        "A1-timestamp-not-handed-over",
        APP,
        "  fire(event.timeStamp);",
        "  fire();",
        COST,
        "the pointerdown's timeStamp never reaches fire(), so the tap can never be measured",
    ),
    (
        "A2-click-instead-of-pointerdown",
        APP,
        "$('fire-btn').addEventListener('pointerdown', (event) => {",
        "$('fire-btn').addEventListener('click', (event) => {",
        COST,
        "the button goes back to click, adding a tap delay of its own",
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
            return mid, "HUNG", "the test process never exited", what
        failures = [line.strip() for line in proc.stdout.splitlines() if line.strip().startswith("not ok")]
        verdict = "FAILED (good)" if failures else "STILL PASSED"
        detail = "; ".join(f.split(" - ", 1)[-1] for f in failures) or "no test failed"
    finally:
        path.write_text(original)
    return mid, verdict, detail, what


if __name__ == "__main__":
    wanted = set(sys.argv[1:])
    worst = 0
    for mutation in MUTATIONS:
        if wanted and mutation[0] not in wanted:
            continue
        mid, verdict, detail, what = run(mutation)
        redundant = mid.endswith("-redundant")
        if verdict != "FAILED (good)" and not (redundant and verdict == "STILL PASSED"):
            worst = 1
        if redundant and verdict == "STILL PASSED":
            verdict = "PASSED (expected)"
        print(f"{mid:36s} {verdict:16s} {what}\n{'':36s} -> {detail}")
    sys.exit(worst)
