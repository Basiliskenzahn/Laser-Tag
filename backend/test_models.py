"""Unit tests for :mod:`backend.models` - the game rules, with no networking.

This is the Python half of the coverage ``deprecated/server/game.test.js`` used to
provide for the (now archived) Node implementation; it exercises the same
scenarios against the ``Room`` class that is actually deployed. See
``docs/development/testing.md`` for why this gap existed and how to run this suite.

``Room.now()`` reads the wall clock directly rather than taking an injectable
clock (unlike the Node version's ``new Room(code, { now })``), so tests that need
to control time monkeypatch the *instance* attribute: ``room.now = lambda: t``.
Python looks up a plain callable stored this way before the class method, and
since it is not bound to the instance it takes no ``self`` - exactly the "fake
clock" the methods already call as ``self.now()``.
"""

import unittest

from backend.models import DAMAGE, MAX_HP, MAX_PLAYERS, Room, SHOT_COOLDOWN_MS, SHOT_COOLDOWN_SLACK_MS, COUNTDOWN_MS

GALLERY = [{"hist": [1, 0], "grid": [0, 1]}]


class FakeClock:
    """A room's `now()` replaced with a controllable counter, in milliseconds."""

    def __init__(self, room):
        self.t = 0
        room.now = lambda: self.t

    def advance(self, ms):
        self.t += ms


def make_room(code="test"):
    room = Room(code)
    clock = FakeClock(room)
    return room, clock


def started_room(names=("a", "b")):
    room, clock = make_room()
    for player_id in names:
        room.join(player_id, player_id, GALLERY)
    room.start()
    clock.advance(COUNTDOWN_MS)
    return room, clock


class RoomTests(unittest.TestCase):
    def test_round_needs_two_players_and_starts_on_request(self):
        room, _ = make_room()
        room.join("a", "Alice", GALLERY)
        self.assertFalse(room.start()["ok"])
        room.join("b", "Bob", GALLERY)
        self.assertEqual(room.status, "waiting")
        self.assertTrue(room.start()["ok"])
        self.assertEqual(room.status, "countdown")

    def test_round_cannot_launch_until_everyone_has_a_scan(self):
        room, _ = make_room()
        room.join("a", "Alice")
        room.join("b", "Bob")
        self.assertFalse(room.start()["ok"])
        self.assertTrue(room.set_gallery("a", GALLERY)["ok"])
        self.assertFalse(room.start()["ok"])
        self.assertTrue(room.set_gallery("b", GALLERY)["ok"])
        self.assertTrue(room.start()["ok"])

    def test_room_caps_out_and_rejects_joins_once_running(self):
        room, _ = make_room()
        for i in range(MAX_PLAYERS):
            self.assertTrue(room.join(f"p{i}", f"P{i}", GALLERY)["ok"])
        self.assertEqual(len(room.players), MAX_PLAYERS)
        self.assertFalse(room.join("extra", "Extra", [])["ok"])

        room.start()
        late = room.join("late", "Late", [])
        self.assertFalse(late["ok"])
        self.assertEqual(late["error"], "Lobby is already running.")

    def test_shots_are_ignored_during_the_countdown(self):
        room, _ = make_room()
        room.join("a", "Alice", GALLERY)
        room.join("b", "Bob", GALLERY)
        room.start()
        self.assertFalse(room.shoot("a", "b", "body")["ok"])
        self.assertEqual(room.players["b"].hp, MAX_HP)

    def test_hits_damage_the_target_and_respect_the_cooldown(self):
        room, clock = started_room()
        self.assertEqual(room.shoot("a", "b", "body")["damage"], DAMAGE["body"])
        self.assertFalse(room.shoot("a", "b", "body")["ok"])  # cooldown
        clock.advance(SHOT_COOLDOWN_MS)
        self.assertEqual(room.shoot("a", "b", "head")["damage"], DAMAGE["head"])
        self.assertEqual(room.players["b"].hp, MAX_HP - DAMAGE["body"] - DAMAGE["head"])

    def test_cooldown_allows_a_little_slack_for_network_jitter(self):
        room, clock = started_room()
        room.shoot("a", None, None)
        clock.advance(SHOT_COOLDOWN_MS - SHOT_COOLDOWN_SLACK_MS - 1)
        self.assertEqual(room.shoot("a", None, None)["error"], "Cooldown")
        clock.advance(1)
        self.assertTrue(room.shoot("a", None, None)["ok"])

    def test_cannot_target_self_or_someone_outside_the_room(self):
        room, _ = started_room()
        self.assertFalse(room.shoot("a", "a", "body")["ok"])
        self.assertFalse(room.shoot("a", "ghost", "body")["ok"])

    def test_unhashable_zone_or_target_id_is_a_clean_error_not_a_crash(self):
        room, _ = started_room()
        self.assertFalse(room.shoot("a", "b", ["body"])["ok"])
        self.assertFalse(room.shoot("a", {"id": "b"}, "body")["ok"])
        self.assertFalse(room.shoot(["a"], "b", "body")["ok"])

    def test_knockout_ends_a_two_player_round_and_the_winner_can_start_the_next_one(self):
        room, clock = started_room()
        result = {"ko": False}
        while not result["ko"]:
            result = room.shoot("a", "b", "head")
            clock.advance(SHOT_COOLDOWN_MS)
        self.assertEqual(room.status, "over")
        self.assertEqual(room.winner, "a")
        self.assertEqual(room.players["a"].wins, 1)
        self.assertFalse(room.shoot("a", "b", "body")["ok"])

        self.assertTrue(room.start()["ok"])
        self.assertEqual(room.status, "countdown")
        self.assertEqual(room.players["b"].hp, MAX_HP)
        self.assertTrue(room.players["b"].alive)

    def test_free_for_all_last_standing_wins_eliminated_cannot_be_hit(self):
        room, clock = started_room(("a", "b", "c"))
        result = {"ko": False}
        while not result["ko"]:
            result = room.shoot("a", "b", "head")
            clock.advance(SHOT_COOLDOWN_MS)
        self.assertFalse(room.players["b"].alive)
        self.assertEqual(room.status, "playing")  # c is still standing
        self.assertEqual(room.shoot("a", "b", "body"), {"ok": True, "hit": False})
        self.assertEqual(room.players["b"].hp, 0)
        clock.advance(SHOT_COOLDOWN_MS)

        result = {"ko": False}
        while not result["ko"]:
            result = room.shoot("a", "c", "head")
            clock.advance(SHOT_COOLDOWN_MS)
        self.assertEqual(room.status, "over")
        self.assertEqual(room.winner, "a")

    def test_leaving_a_free_for_all_removes_that_player_without_resetting(self):
        room, _ = started_room(("a", "b", "c"))
        room.shoot("a", "b", "body")
        room.leave("b")
        self.assertEqual(room.status, "playing")
        self.assertNotIn("b", room.players)
        self.assertEqual(room.players["a"].hp, MAX_HP)
        self.assertEqual(room.players["c"].hp, MAX_HP)

    def test_leaving_can_decide_a_free_for_all(self):
        room, clock = started_room(("a", "b", "c"))
        result = {"ko": False}
        while not result["ko"]:
            result = room.shoot("a", "b", "head")
            clock.advance(SHOT_COOLDOWN_MS)

        room.leave("c")
        self.assertEqual(room.status, "over")
        self.assertEqual(room.winner, "a")
        self.assertEqual(room.players["a"].wins, 1)

    def test_forfeit_mid_round_is_a_knockout_that_stays_on_the_scoreboard(self):
        room, _ = started_room(("a", "b", "c"))
        self.assertEqual(room.forfeit("b"), {"ok": True, "ko": True})
        self.assertEqual(room.status, "playing")
        down = next(p for p in room.snapshot()["players"] if p["id"] == "b")
        self.assertEqual((down["hp"], down["alive"], down["forfeited"]), (0, False, True))
        self.assertFalse(room.shoot("a", "b", "body")["hit"])
        self.assertFalse(room.shoot("b", "a", "body")["ok"])  # the forfeited player can't shoot

    def test_forfeit_can_decide_the_round_and_then_leaves_the_room(self):
        room, _ = started_room(("a", "b", "c"))
        room.forfeit("b")
        room.forfeit("c")
        self.assertEqual(room.status, "over")
        self.assertEqual(room.winner, "a")
        self.assertEqual(room.players["a"].wins, 1)
        self.assertEqual(list(room.players), ["a"])

    def test_a_forfeit_that_decides_the_round_awards_exactly_one_win(self):
        # finish_if_decided has no "already over" guard of its own - it relies on
        # forfeit() and leave() only calling it while the round is playing. The
        # second goodbye is not hypothetical: Session.close forfeits the player id
        # and then the clone id, so the second call always happens.
        room, _ = started_room(("a", "b", "c"))
        room.players["a"].wins = 3  # won three earlier rounds

        self.assertEqual(room.forfeit("b"), {"ok": True, "ko": True})
        self.assertEqual((room.status, room.winner), ("playing", None),
                         "two are still standing, so nobody has won")
        self.assertEqual(room.players["a"].wins, 3)

        self.assertEqual(room.forfeit("c"), {"ok": True, "ko": True})
        self.assertEqual((room.status, room.winner), ("over", "a"))
        self.assertEqual(room.players["a"].wins, 4)

        self.assertFalse(room.forfeit("b")["ok"])  # pruned by the round ending
        self.assertFalse(room.forfeit("a:debug-clone")["ok"])
        room.leave("b")
        self.assertEqual(room.players["a"].wins, 4)

    def test_a_forfeited_player_never_reaches_the_next_round_still_marked(self):
        # forfeited players are pruned by finish_if_decided, which is the only exit
        # from "playing", so nothing should reach start() still carrying the flag.
        # Reset there anyway, with the rest of the per-round state: resting a field
        # the scoreboard shows on an argument about reachability is how it ends up
        # shown on a live player.
        # First the reachable half: a forfeited player is gone by the time the room
        # is startable again.
        room, _ = started_room(("a", "b", "c"))
        room.forfeit("b")
        self.assertEqual(room.status, "playing")
        room.leave("c")  # decides the round, which is what prunes b
        self.assertEqual(list(room.players), ["a"])

        # Then the unreachable one, set by hand: nothing should be able to carry the
        # flag into start(), and start() clears it regardless.
        room.join("b", "Bob again", GALLERY)
        room.players["b"].forfeited = True
        self.assertTrue(room.start()["ok"])
        self.assertEqual([p["forfeited"] for p in room.snapshot()["players"]], [False, False])

    def test_forfeit_outside_a_live_round_is_a_plain_leave(self):
        room, _ = make_room()
        room.join("a", "Alice", GALLERY)
        room.join("b", "Bob", GALLERY)
        self.assertEqual(room.forfeit("b"), {"ok": True, "ko": False})
        self.assertNotIn("b", room.players)
        self.assertFalse(room.forfeit("ghost")["ok"])

    def test_misses_count_as_shots_but_need_a_live_round_shooter_and_cooldown(self):
        room, clock = started_room()
        self.assertEqual(room.shoot("a", None, None), {"ok": True, "hit": False})
        self.assertEqual(room.shoot("a", None, None)["error"], "Cooldown")
        clock.advance(SHOT_COOLDOWN_MS)
        self.assertTrue(room.shoot("a", "b", "body")["hit"])
        self.assertEqual(room.players["a"].stats.shots, 2)
        self.assertEqual(room.players["a"].stats.hits, 1)
        self.assertEqual(room.players["b"].hp, MAX_HP - DAMAGE["body"])
        self.assertFalse(room.shoot("ghost", None, None)["ok"])

        waiting, _ = make_room()
        waiting.join("a", "Alice", GALLERY)
        self.assertFalse(waiting.shoot("a", None, None)["ok"])
        self.assertEqual(waiting.players["a"].stats.shots, 0)

    def test_round_stats_track_what_each_player_did(self):
        room, clock = started_room(("a", "b", "c"))
        room.shoot("a", "b", "head")  # b: 50
        clock.advance(SHOT_COOLDOWN_MS)
        room.shoot("a", None, None)
        clock.advance(SHOT_COOLDOWN_MS)
        room.shoot("a", "b", "body")  # b: 30
        clock.advance(SHOT_COOLDOWN_MS)
        room.shoot("a", "b", "head")  # b: 0, a 50-point headshot that only had 30 HP to take
        clock.advance(10_000)
        room.forfeit("c")

        stats = {p["id"]: p["stats"] for p in room.snapshot()["players"]}
        self.assertEqual(room.status, "over")
        self.assertEqual(
            stats["a"],
            {"kills": 1, "damage": 100, "shots": 4, "hits": 3, "headshots": 2, "timeAliveMs": 3 * SHOT_COOLDOWN_MS + 10_000},
        )
        self.assertEqual(stats["b"]["timeAliveMs"], 3 * SHOT_COOLDOWN_MS)
        self.assertEqual(stats["b"]["kills"], 0)
        self.assertNotIn("c", stats)  # forfeited players leave once the round is over

        clock.advance(5_000)
        self.assertEqual(room.snapshot()["players"][0]["stats"]["timeAliveMs"], 3 * SHOT_COOLDOWN_MS + 10_000)

    def test_stats_reset_when_the_next_round_starts(self):
        room, clock = started_room()
        room.shoot("a", "b", "head")
        clock.advance(SHOT_COOLDOWN_MS)
        room.shoot("a", "b", "head")
        self.assertEqual(room.status, "over")
        room.start()
        for player in room.snapshot()["players"]:
            self.assertEqual(
                player["stats"],
                {"kills": 0, "damage": 0, "shots": 0, "hits": 0, "headshots": 0, "timeAliveMs": 0},
            )

    def test_the_next_round_keeps_the_scans_and_their_revisions(self):
        # start() resets every per-round field, and a gallery is not one. Taking a
        # revision back would tell a phone already holding that scan to keep holding
        # it under a number the server had reused, which is the one thing the roster
        # delta cannot survive (transport.roster_for).
        room, clock = make_room()
        room.join("a", "Alice", [])
        room.join("b", "Bob", [])
        room.set_gallery("a", GALLERY)
        room.set_gallery("b", GALLERY)
        revisions = {pid: p.gallery_rev for pid, p in room.players.items()}
        # Joining with a gallery leaves the revision at 0, which a reset to 0 would
        # be indistinguishable from. These have to be scanned-in revisions.
        self.assertTrue(all(revisions.values()), revisions)

        self.assertTrue(room.start()["ok"])
        clock.advance(COUNTDOWN_MS)
        room.shoot("a", "b", "head")
        clock.advance(SHOT_COOLDOWN_MS)
        room.shoot("a", "b", "head")
        self.assertEqual(room.status, "over")

        self.assertTrue(room.start()["ok"])
        self.assertEqual({pid: p.gallery_rev for pid, p in room.players.items()}, revisions)
        self.assertEqual(room.players["b"].gallery, GALLERY)
        self.assertEqual(room.players["a"].wins, 1, "the lobby tally is not per-round either")

    def test_a_deleted_scan_blocks_the_next_launch_until_it_is_retaken(self):
        # The launch guard and clear_gallery meet here: deleting a scan has to put
        # that player back among the unscanned, or a round starts with a player
        # nobody's phone can recognise.
        room, _ = make_room()
        room.join("a", "Alice", GALLERY)
        room.join("b", "Bob", GALLERY)
        self.assertTrue(room.clear_gallery("b")["ok"])

        refused = room.start()
        self.assertFalse(refused["ok"])
        self.assertIn("Bob", refused["error"])
        self.assertEqual(room.status, "waiting")
        room.set_gallery("b", GALLERY)
        self.assertTrue(room.start()["ok"])

    def test_the_roster_carries_galleries_the_snapshot_and_a_light_entry_do_not(self):
        room, _ = make_room()
        room.join("a", "Alice", GALLERY)
        self.assertEqual(room.roster()[0]["gallery"], GALLERY)
        self.assertNotIn("gallery", room.snapshot()["players"][0])
        # A light entry is what lets the transport send a phone only the scans it
        # hasn't got yet. The identity half always travels, so a roster message
        # is always the whole room.
        self.assertEqual(room.roster_entry(room.players["a"], gallery=False),
                         {"id": "a", "name": "Alice"})

    def test_debug_clone_mirrors_its_owners_gallery(self):
        room, _ = make_room()
        room.join("a", "Alice", [])
        room.join("a:debug-clone", "Alice clone", [])
        room.set_gallery("a", GALLERY)
        self.assertEqual(room.roster()[1]["gallery"], GALLERY)
        self.assertEqual(room.unscanned_players(), [])

    def test_scanning_a_clone_updates_its_owner_too(self):
        room, _ = make_room()
        room.join("a", "Alice", [])
        room.join("a:debug-clone", "Alice clone", [])
        room.set_gallery("a:debug-clone", GALLERY)
        self.assertEqual(room.players["a"].gallery, GALLERY)

    def test_every_gallery_change_moves_the_revision(self):
        # The revision is how the transport tells "this phone already has it" from "this phone
        # has a stale copy". If a write could slip past it, a rescan would never be delivered.
        room, _ = make_room()
        room.join("a", "Alice", [])
        start = room.players["a"].gallery_rev
        room.set_gallery("a", GALLERY)
        first = room.players["a"].gallery_rev
        self.assertNotEqual(first, start)
        room.set_gallery("a", [{"hist": [0, 1], "grid": [1, 0]}])
        second = room.players["a"].gallery_rev
        self.assertNotEqual(second, first)
        # A refused scan changes nothing, so nothing is re-sent either.
        self.assertFalse(room.set_gallery("a", [])["ok"])
        self.assertEqual(room.players["a"].gallery_rev, second)

    def test_reseating_an_id_is_refused_so_a_revision_can_never_go_backwards(self):
        # The revision only ever counts up, which is what lets the transport treat
        # "same number" as "this phone still holds that scan". Reseating an id
        # handed it a brand new Player with the count back at 0, so every phone
        # that had been told revision 0 would be told to keep what it held about a
        # completely different gallery. Reconnects go through the adoption path in
        # transport.Session._join, so nothing should reach this.
        room, _ = make_room()
        room.join("a", "Alice", [])
        room.set_gallery("a", GALLERY)
        seated = room.players["a"]
        revision = seated.gallery_rev
        self.assertNotEqual(revision, 0)

        again = room.join("a", "Alice on a new phone", [])
        self.assertFalse(again["ok"])
        self.assertIs(room.players["a"], seated, "the seated player must not be replaced")
        self.assertEqual(room.players["a"].gallery_rev, revision)
        self.assertEqual(room.players["a"].gallery, GALLERY)

    def test_a_clones_revision_follows_the_owner_it_borrows_from(self):
        # mirrored_gallery_rev has to move exactly when mirrored_gallery does, or a phone would
        # keep matching the clone against a scan that has since been replaced.
        room, _ = make_room()
        room.join("a", "Alice", [])
        room.join("a:debug-clone", "Alice clone", [])
        clone = room.players["a:debug-clone"]
        before = room.mirrored_gallery_rev(clone)
        room.set_gallery("a", GALLERY)
        self.assertNotEqual(room.mirrored_gallery_rev(clone), before)
        self.assertEqual(room.mirrored_gallery(clone), GALLERY)
        self.assertEqual(room.mirrored_gallery_rev(clone), room.players["a"].gallery_rev)

    def test_clearing_a_scan_unscans_the_player_and_its_clone(self):
        room, _ = make_room()
        room.join("a", "Alice", [])
        room.join("a:debug-clone", "Alice clone", [])
        room.set_gallery("a", GALLERY)
        self.assertTrue(room.clear_gallery("a")["ok"])
        self.assertEqual(room.players["a"].gallery, [])
        self.assertEqual(room.roster()[1]["gallery"], [])
        self.assertEqual([p.id for p in room.unscanned_players()], ["a"])

    def test_clearing_a_scan_moves_the_revision_for_the_player_and_the_clone(self):
        # The one interaction between deleting a scan and the roster delta. A
        # revision that did not move leaves the delta saying "keep what you have"
        # about a gallery that is gone, and the deleted scan then lives on every
        # other phone for the rest of the round.
        room, _ = make_room()
        room.join("a", "Alice", [])
        room.join("a:debug-clone", "Alice clone", [])
        room.set_gallery("a", GALLERY)
        clone = room.players["a:debug-clone"]
        scanned = room.players["a"].gallery_rev
        scanned_clone = room.mirrored_gallery_rev(clone)

        self.assertTrue(room.clear_gallery("a")["ok"])
        self.assertNotEqual(room.players["a"].gallery_rev, scanned)
        self.assertNotEqual(room.mirrored_gallery_rev(clone), scanned_clone)
        # A refused deletion must not move it, or every phone is sent a gallery again
        # for nothing.
        after = room.players["a"].gallery_rev
        self.assertFalse(room.clear_gallery("nobody")["ok"])
        self.assertEqual(room.players["a"].gallery_rev, after)

        # Deleting through the clone's id has to move the owner's revision too, the
        # same way scanning the clone writes the owner's gallery.
        room.set_gallery("a:debug-clone", GALLERY)
        rescanned = room.players["a"].gallery_rev
        self.assertTrue(room.clear_gallery("a:debug-clone")["ok"])
        self.assertNotEqual(room.players["a"].gallery_rev, rescanned)
        self.assertEqual(room.players["a"].gallery, [])

    def test_clearing_a_scan_is_refused_mid_round_and_for_unknown_players(self):
        room, _ = make_room()
        room.join("a", "Alice", GALLERY)
        room.join("b", "Bob", GALLERY)
        self.assertFalse(room.clear_gallery("nobody")["ok"])
        self.assertTrue(room.start()["ok"])
        self.assertEqual(room.clear_gallery("a"), {"ok": False, "error": "Round already running"})
        self.assertEqual(room.players["a"].gallery, GALLERY)

    def test_an_empty_scan_still_does_not_clear_one(self):
        room, _ = make_room()
        room.join("a", "Alice", GALLERY)
        self.assertFalse(room.set_gallery("a", [])["ok"])
        self.assertEqual(room.players["a"].gallery, GALLERY)


if __name__ == "__main__":
    unittest.main()
