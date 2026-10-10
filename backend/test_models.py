"""Unit tests for :mod:`backend.models` - the game rules, with no networking.

This is the Python half of the coverage ``deprecated/server/game.test.js`` used to
provide for the (now archived) Node implementation; it exercises the same
scenarios against the ``Room`` class that is actually deployed. See
``docs/streamlining.md`` for why this gap existed and ``docs/development/testing.md``
for how to run this suite.

``Room.now()`` reads the wall clock directly rather than taking an injectable
clock (unlike the Node version's ``new Room(code, { now })``), so tests that need
to control time monkeypatch the *instance* attribute: ``room.now = lambda: t``.
Python looks up a plain callable stored this way before the class method, and
since it is not bound to the instance it takes no ``self`` - exactly the "fake
clock" the methods already call as ``self.now()``.
"""

import unittest

from backend.models import DAMAGE, MAX_HP, MAX_PLAYERS, Room, SHOT_COOLDOWN_MS, COUNTDOWN_MS

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
        self.assertFalse(room.shoot("a", "b", "body")["ok"])

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

    def test_roster_carries_gallery_snapshot_does_not(self):
        room, _ = make_room()
        room.join("a", "Alice", [{"hist": [1, 0], "grid": [0.5]}])
        roster = room.roster()
        self.assertEqual(roster[0]["gallery"], [{"hist": [1, 0], "grid": [0.5]}])
        self.assertNotIn("gallery", room.snapshot()["players"][0])

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


if __name__ == "__main__":
    unittest.main()
