"""Mutation checker for the backend's robustness fixes.

Each entry undoes exactly one fix and names the tests that are supposed to
notice. A mutation whose tests stay green means those tests assert nothing - that
is the whole point of running this. Three of the entries below were written
*because* breaking the guard left the suite passing.

    python -m backend.mutation_check            # all of them
    python -m backend.mutation_check M2 M14     # just these

!! WARNING: ``restore()`` runs ``git checkout -- backend/``, which DISCARDS every
   uncommitted change under ``backend/`` - test files included. Commit before you
   run this. It has already eaten two freshly written tests, and a lost test looks
   exactly like a killed mutation: the run reports "killed" because the test
   errored with AttributeError for not existing. If a verdict line mentions
   AttributeError on a test name, that is a false kill, not a real one.

It is slow (minutes, not seconds), and the cost is almost all real-time waiting
rather than work: several of these tests sit out ``COUNTDOWN_MS`` (3 s) or a
``POLL_WAIT_MS`` park, and each mutation pays a fresh interpreter start. If you
need it faster, monkeypatch those constants for the run the way
``test_transport.py`` already patches ``POLL_WAIT_MS`` and ``SWEEP_INTERVAL_S``,
or pass only the labels you care about.
"""
import pathlib
import subprocess
import sys

REPO = str(pathlib.Path(__file__).resolve().parent.parent)
PROTO = "backend.test_protocol.ProtocolTests."
POLLER = "backend.test_transport.PollerMailboxTests."
SWEEP = "backend.test_transport.SweepTests."
TIMER = "backend.test_transport.CountdownTimerTests."
SEAT = "backend.test_transport.SeatedWriteAccessTests."
SSE = "backend.test_transport.SseListenerTests."
MODELS = "backend.test_models.RoomTests."

M = []


def mutation(label, fix, path, old, new, tests):
    M.append(dict(label=label, fix=fix, path=path, old=old, new=new, tests=tests))


# ---- bug 1: the /api/hit crash -------------------------------------------
mutation(
    "M1", "bug 1: api_hit's isinstance(msg, dict) guard", "backend/app.py",
    """    if not isinstance(msg, dict):
        return json_response({"ok": False, "error": "Bad JSON"}, 400)
    shooter_id = msg.get("shooterId")""",
    """    shooter_id = msg.get("shooterId")""",
    [PROTO + "test_posted_hit_with_a_non_object_body_is_a_clean_400"],
)

# ---- bug 2: the second-tab freeze ----------------------------------------
mutation(
    "M2", "bug 2: displace() evicts the old mailbox", "backend/transport.py",
    """    evict(poller_for(previous), "replaced")
    previous.room = None  # it no longer speaks for this seat""",
    """    return""",
    [PROTO + "test_remembered_player_id_rejoins_without_duplicate_seat",
     PROTO + "test_a_second_tab_leaves_the_first_phone_told_rather_than_frozen",
     SEAT + "test_a_displaced_session_cannot_write_to_the_room"],
)

mutation(
    "M3", "bug 2: api_poll re-checks liveness after the park", "backend/app.py",
    """    messages = await poller.take()
    if not poller.is_live():
        return gone(poller)
    return json_response(messages)""",
    """    messages = await poller.take()
    return json_response(messages)""",
    [PROTO + "test_a_poll_parked_when_the_seat_is_taken_is_told_on_that_response"],
)

mutation(
    "M10", "bug 7: evict wakes the parked poll", "backend/transport.py",
    """    if poller.session is not None:
        poller.session.sent_gallery_revs = {}
    poller.wake()""",
    """    if poller.session is not None:
        poller.session.sent_gallery_revs = {}""",
    [SWEEP + "test_a_parked_poll_is_woken_when_its_session_is_swept"],
)

# ---- bug 3: the membership check -----------------------------------------
mutation(
    "M5", "bug 3: Session.is_seated membership check", "backend/transport.py",
    """        return (
            self.room is not None
            and connections.get(self.id) is self
            and self.id in self.room.players
        )""",
    """        return self.room is not None""",
    [SEAT + "test_a_session_whose_player_was_removed_cannot_write_to_the_room"],
)

# ---- bug 5: the sweep's try/except ---------------------------------------
mutation(
    "M7", "bug 5: sweep_once's per-session try/except", "backend/transport.py",
    """        try:
            # Wakes whatever poll is parked on it, so an evicted phone is told 410
            # now instead of being answered 200 with a room it has been removed
            # from up to POLL_WAIT_MS later.
            evict(poller, "expired")
            await poller.session.close()
        except Exception:
            log.exception("reaping poll token %s failed", token)""",
    """        evict(poller, "expired")
        await poller.session.close()""",
    [SWEEP + "test_one_session_that_cannot_close_does_not_cost_the_others_their_turn"],
)

mutation(
    "M8", "bug 5: sweep_pollers' loop try/except", "backend/transport.py",
    """        try:
            await sweep_once()
        except Exception:
            log.exception("poll sweep failed")""",
    """        await sweep_once()""",
    [SWEEP + "test_the_sweep_loop_survives_a_pass_that_raises"],
)

# ---- bugs 10 + 11: the queue cap and the roster delta --------------------
mutation(
    "M14", "bug 10: overflow evicts rather than trims", "backend/transport.py",
    """        if len(self.queue) > MAX_QUEUED_MESSAGES:
            evict(self, "overflow")""",
    """        return""",
    [POLLER + "test_a_backlog_of_undroppable_messages_evicts_the_mailbox"],
)

mutation(
    "M16", "bug 10: superseded state snapshots are collapsed", "backend/transport.py",
    """        newest_state = next(
            (i for i in range(len(self.queue) - 1, -1, -1) if self.queue[i].get("type") == "state"),
            None,
        )
        if newest_state is not None:
            self.queue = [
                msg for i, msg in enumerate(self.queue)
                if msg.get("type") != "state" or i == newest_state
            ]""",
    "",
    [POLLER + "test_only_the_newest_scoreboard_is_kept_under_pressure"],
)

mutation(
    "M17", "bug 10: an evicted mailbox takes nothing", "backend/transport.py",
    """        if self.evicted:
            return False
        self.queue.append(msg)""",
    """        self.queue.append(msg)""",
    [POLLER + "test_an_evicted_mailbox_takes_nothing_more"],
)

mutation(
    "M18", "bugs 10+11: eviction clears the delivery record", "backend/transport.py",
    """    if poller.session is not None:
        poller.session.sent_gallery_revs = {}
""",
    "",
    [POLLER + "test_eviction_forgets_what_the_server_believed_it_delivered",
     PROTO + "test_a_phone_whose_mailbox_overflows_reconnects_complete"],
)

mutation(
    "M19", "bug 11: revisions recorded only once the mailbox takes the message",
    "backend/transport.py",
    """        entries, revisions = roster_for(session, room)
        # Recorded only after the mailbox has taken it, never before: an evicted
        # mailbox takes nothing, and a phone must never be told "keep what you
        # have" about a gallery that was dropped on the way to it.
        if await session.send({"type": "roster", "players": entries}):
            session.sent_gallery_revs = revisions""",
    """        entries, revisions = roster_for(session, room)
        session.sent_gallery_revs = revisions
        await session.send({"type": "roster", "players": entries})""",
    [POLLER + "test_a_refused_roster_is_not_recorded_as_delivered"],
)

# ---- the rest ------------------------------------------------------------
mutation(
    "M4", "bug 2: api_send refuses an evicted mailbox", "backend/app.py",
    """    poller = pollers.get(token)
    if poller is None or not poller.is_live():
        return gone(poller)
    if request.content_length""",
    """    poller = pollers.get(token)
    if poller is None:
        return gone(poller)
    if request.content_length""",
    [PROTO + "test_a_phone_whose_mailbox_overflows_reconnects_complete"],
)

mutation(
    "M6", "bug 4: sse_clients drops its empty room entry", "backend/transport.py",
    """    listeners.discard(queue)
    if not listeners:
        sse_clients.pop(room_code, None)""",
    """    listeners.discard(queue)""",
    [PROTO + "test_an_sse_listener_is_forgotten_when_it_disconnects"],
)

mutation(
    "M9", "bug 6: the timer leaves its slot before broadcasting", "backend/transport.py",
    """    state = room.snapshot()
    if room.start_timer is not None:
        room.start_timer.cancel()
        room.start_timer = None
    for player_id in list(room.players.keys()):
        await send_to(player_id, {"type": "state", "state": state})
    if state["status"] == "countdown":
        async def later():
            await asyncio.sleep((state["startsInMs"] + 10) / 1000)
            # Past the point of being cancelled, and no await in between, so this
            # hands the slot back atomically. Guarded because a broadcast that
            # raced us to the cancel may already have put a newer timer there.
            if room.start_timer is asyncio.current_task():
                room.start_timer = None
            await broadcast_state(room)

        room.start_timer = asyncio.create_task(later())""",
    """    state = room.snapshot()
    for player_id in list(room.players.keys()):
        await send_to(player_id, {"type": "state", "state": state})
    if room.start_timer:
        room.start_timer.cancel()
        room.start_timer = None
    if state["status"] == "countdown":
        async def later():
            await asyncio.sleep((state["startsInMs"] + 10) / 1000)
            await broadcast_state(room)

        room.start_timer = asyncio.create_task(later())""",
    [TIMER + "test_a_broadcasting_timer_is_not_reachable_for_cancellation",
     TIMER + "test_the_countdown_broadcast_finishes_even_when_a_send_suspends"],
)

mutation(
    "M11", "bug 8: one future per parked poll", "backend/transport.py",
    """    def wake(self):
        \"\"\"Resolve every parked poll, so each returns with whatever is queued.\"\"\"
        for waiter in self.waiters:
            if not waiter.done():
                waiter.set_result(True)""",
    """    def wake(self):
        if self.waiters and not self.waiters[-1].done():
            self.waiters[-1].set_result(True)""",
    [POLLER + "test_two_polls_parked_on_one_token_are_both_woken"],
)

mutation(
    "M12", "bug 8: take() clears only its own future", "backend/transport.py",
    """            finally:
                # Only ever this poll's own future: a timing-out poll used to null
                # the single slot another poll was parked on.
                if waiter in self.waiters:
                    self.waiters.remove(waiter)""",
    """            finally:
                self.waiters.clear()""",
    [POLLER + "test_a_timed_out_poll_does_not_strand_another_parked_one"],
)

mutation(
    "M13", "bug 9: Room.join refuses to reseat an id", "backend/models.py",
    """        if player_id in self.players:
            return {"ok": False, "error": "Already in this room"}
""",
    "",
    [MODELS + "test_reseating_an_id_is_refused_so_a_revision_can_never_go_backwards"],
)

mutation(
    "M20", "bug 12: events lets CancelledError propagate", "backend/app.py",
    """    except ConnectionResetError:
        pass""",
    """    except (asyncio.CancelledError, ConnectionResetError):
        pass""",
    [SSE + "test_a_cancelled_listener_propagates_and_is_forgotten"],
)

mutation(
    "M21", "bug 12: shutdown cancels countdown timers", "backend/transport.py",
    """    timers = []
    for room in list(rooms.values()):
        if room.start_timer is not None:
            timers.append(room.start_timer)
            room.start_timer.cancel()
            room.start_timer = None
    if timers:
        await asyncio.gather(*timers, return_exceptions=True)""",
    """    return""",
    [TIMER + "test_shutdown_cancels_a_pending_countdown_timer"],
)

mutation(
    "M22", "bug 13: the body-size boundary matches aiohttp's", "backend/app.py",
    """    if request.content_length and request.content_length >= MAX_BODY_BYTES:""",
    """    if request.content_length and request.content_length > MAX_BODY_BYTES:""",
    [PROTO + "test_an_oversized_or_malformed_body_is_one_json_shape_either_way"],
)

mutation(
    "M23", "bug 13: one 413 shape for a chunked body too", "backend/app.py",
    """    except web.HTTPRequestEntityTooLarge:
        # A chunked body has no Content-Length for the check above, so aiohttp's
        # own client_max_size is what catches it - and it answers a plain-text
        # 413. Caught so an oversized body gets one shape either way.
        return json_response({"error": "Body too large"}, 413)
""",
    "",
    [PROTO + "test_an_oversized_or_malformed_body_is_one_json_shape_either_way"],
)

mutation(
    "M24", "the SSE backlog cap", "backend/transport.py",
    """            if queue.full():
                queue.get_nowait()
            queue.put_nowait(event)""",
    """            await queue.put(event)""",
    [SSE + "test_a_stalled_listener_loses_its_oldest_events_not_the_server"],
)


def run(tests):
    proc = subprocess.run(
        [sys.executable, "-m", "unittest", *tests],
        cwd=REPO, capture_output=True, text=True, timeout=900,
    )
    return proc.returncode == 0, proc.stdout + proc.stderr


def restore():
    subprocess.run(["git", "checkout", "--", "backend/"], cwd=REPO, check=True)


def main():
    only = sys.argv[1:] or None
    results = []
    for mut in M:
        if only and mut["label"] not in only:
            continue
        path = f"{REPO}/{mut['path']}"
        with open(path) as handle:
            source = handle.read()
        found = source.count(mut["old"])
        if found != 1:
            print(f"!! {mut['label']:4} ANCHOR-ERROR ({found}x) {mut['fix']}", flush=True)
            results.append((mut["label"], "ANCHOR-ERROR", mut["fix"]))
            continue
        with open(path, "w") as handle:
            handle.write(source.replace(mut["old"], mut["new"]))
        try:
            ok, output = run(mut["tests"])
        finally:
            restore()
        verdict = "SURVIVED(bad)" if ok else "killed"
        print(f"{mut['label']:4} {verdict:14} {mut['fix']}", flush=True)
        reasons = [line.strip() for line in output.splitlines()
                   if line.startswith(("AssertionError", "RuntimeError", "AttributeError"))
                   or "TimeoutError" in line]
        if reasons:
            print(f"       observed: {reasons[0][:160]}", flush=True)
        elif not ok:
            tail = [line for line in output.splitlines() if "FAILED" in line or "Error" in line]
            print(f"       observed: {(tail[0] if tail else '')[:160]}", flush=True)
        results.append((mut["label"], verdict, mut["fix"]))

    print("\n==== SUMMARY ====", flush=True)
    bad = [r for r in results if r[1] != "killed"]
    for label, verdict, fix in results:
        print(f"{label:4} {verdict:14} {fix}")
    print(f"\n{len(results) - len(bad)}/{len(results)} killed")
    if bad:
        print("NOT KILLED:", ", ".join(r[0] for r in bad))


if __name__ == "__main__":
    main()
