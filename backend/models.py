"""Pure game logic for a single laser-tag room.

No networking here, so the rules can be reasoned about (and unit tested) on their
own: every method is synchronous, takes plain data, and returns plain data. The
transport layer (``backend.transport``) is what turns these return values into
messages on the wire, and ``backend.app`` is what turns HTTP requests into calls
on a :class:`Room`.

The numbers in this module are the live game balance - they are the source of
truth for the Python backend, which is the deployment that actually runs.
"""

import time
from dataclasses import dataclass, field

MIN_PLAYERS = 2
MAX_PLAYERS = 8
MAX_HP = 100
DAMAGE = {"body": 20, "head": 50}
SHOT_COOLDOWN_MS = 350
#: How much sooner than ``SHOT_COOLDOWN_MS`` a shot may arrive and still count. The phone
#: spaces shots by when they were fired, but network jitter can bunch two of them up on the
#: way here, and a shot the player saw fire should not be thrown away for that.
SHOT_COOLDOWN_SLACK_MS = 60
COUNTDOWN_MS = 3000

#: Suffix that marks the second, fake player a phone can add to a room for
#: single-device testing. See :meth:`Room.clone_owner_id`.
CLONE_SUFFIX = ":debug-clone"


@dataclass
class RoundStats:
    """What one player did in the current round (or the last one), for the results screen.

    ``shots`` counts every shot the server accepted, misses included, so that
    ``hits / shots`` is the player's accuracy. ``damage`` is the HP actually taken
    off opponents: a 50-point headshot on a target with 20 HP left counts as 20.
    """

    kills: int = 0
    damage: int = 0
    shots: int = 0
    hits: int = 0
    headshots: int = 0


@dataclass
class Player:
    """One phone in a room.

    ``gallery`` is the appearance signature captured during enrolment: a list of
    ``{hist, grid, ...}`` samples, one per angle the player was scanned from. The
    server only stores and relays it; the actual matching happens on the phones.

    ``last_shot_at`` starts at negative infinity so that a player's very first
    shot is never held back by the cooldown check.

    ``gallery_rev`` counts how many times the gallery has been replaced. Nothing
    in the game rules reads it; it exists so the transport can tell whether a
    phone it already talked to still holds the current scan, and therefore skip
    re-sending a payload that phone already has (see
    :func:`backend.transport.roster_for`).

    ``forfeited`` marks a player who left mid-round: they stay seated, knocked
    out, until the round ends, then :meth:`Room.finish_if_decided` drops them.

    ``stats`` and ``out_at`` (when this round ended for them: knocked out or
    forfeited) are reset by :meth:`Room.start`.
    """

    id: str
    name: str
    gallery: list
    hp: int = MAX_HP
    wins: int = 0
    alive: bool = True
    forfeited: bool = False
    last_shot_at: float = float("-inf")
    gallery_rev: int = 0
    stats: RoundStats = field(default_factory=RoundStats)
    out_at: float | None = None


class Room:
    """A lobby plus the round being played in it.

    Status moves ``waiting -> countdown -> playing -> over`` and back to
    ``waiting`` on the next :meth:`start`. Callers must treat the returned dicts
    as the only channel for failures: these methods never raise for bad input,
    they return ``{"ok": False, "error": ...}`` so the transport can forward the
    message straight to the player who caused it.
    """

    def __init__(self, code):
        self.code = code
        self.players = {}
        self.status = "waiting"  # waiting | countdown | playing | over
        self.starts_at = None
        self.winner = None
        # When the current (or last) round went from countdown to playing, and when it
        # ended - the bounds of every player's time alive.
        self.started_at = None
        self.ended_at = None
        # Handle for the pending "countdown finished, re-broadcast state" task.
        # Owned entirely by the transport layer (see transport.broadcast_state);
        # it lives here only so every Room has the slot, which keeps this module
        # free of any asyncio import.
        self.start_timer = None

    @property
    def is_empty(self):
        return not self.players

    def now(self):
        """Wall-clock milliseconds, matching the client's ``Date.now()``."""
        return time.time() * 1000

    def _player(self, player_id):
        """Look up a player by an id that came from an untrusted client.

        Ids are always strings internally, so anything else is simply unknown.
        The isinstance guard matters because a raw JSON value such as ``[]`` or
        ``{}`` is unhashable and would make a plain ``players.get(...)`` raise
        ``TypeError`` instead of reporting "Unknown player".
        """
        if not isinstance(player_id, str):
            return None
        return self.players.get(player_id)

    def join(self, player_id, name, gallery=None):
        """Seat a new player. Never reseats an id that is already in the room.

        That last part is a structural guarantee the roster delta depends on, not
        a convenience: reseating would hand the id a brand new :class:`Player`
        with ``gallery_rev`` back at ``0``, and every phone that had been told
        "revision 0" for that player would then be told to keep what it held about
        a completely different gallery (see
        :func:`backend.transport.roster_for`). A reconnecting phone is routed to
        the adoption path in ``transport.Session._join`` and a fresh one always
        brings an id of its own, so nothing reaches this today - which is exactly
        why it is refused outright rather than left resting on that.
        """
        if self.status in ("countdown", "playing"):
            return {"ok": False, "error": "Lobby is already running."}
        if player_id in self.players:
            return {"ok": False, "error": "Already in this room"}
        if len(self.players) >= MAX_PLAYERS:
            return {"ok": False, "error": "Room is full"}
        self.players[player_id] = Player(player_id, name, gallery or [])
        return {"ok": True}

    def clone_owner_id(self, player_id):
        """The real player behind a debug clone id, or ``None`` for real players."""
        return (
            player_id[: -len(CLONE_SUFFIX)]
            if isinstance(player_id, str) and player_id.endswith(CLONE_SUFFIX)
            else None
        )

    def mirrored_gallery(self, player):
        """A debug clone has no scan of its own - it borrows its owner's."""
        owner_id = self.clone_owner_id(player.id)
        if owner_id and owner_id in self.players:
            return self.players[owner_id].gallery
        return player.gallery

    def mirrored_gallery_rev(self, player):
        """The revision of whatever :meth:`mirrored_gallery` would return.

        Resolved through the owner for exactly the same reason the gallery is, so
        the two cannot disagree about *when* a clone's scan changed: a borrowed
        gallery changes precisely when its owner's does. Callers only ever
        compare this for equality, so the absolute number means nothing.
        """
        owner_id = self.clone_owner_id(player.id)
        if owner_id and owner_id in self.players:
            return self.players[owner_id].gallery_rev
        return player.gallery_rev

    def set_gallery(self, player_id, gallery):
        """Store a scan of ``player_id``, keeping any debug clone in sync.

        Anyone in the lobby may scan anyone else, so the id here is attacker
        controlled; it is resolved through :meth:`_player`.
        """
        if self.status in ("countdown", "playing"):
            return {"ok": False, "error": "Round already running"}
        player = self._player(player_id)
        if not player:
            return {"ok": False, "error": "Unknown player"}
        if not gallery:
            return {"ok": False, "error": "Scan did not contain enough samples"}
        self._store_gallery(player_id, gallery)
        return {"ok": True}

    def clear_gallery(self, player_id):
        """Delete the scan of ``player_id`` (and its debug clone's), so they need scanning again.

        Kept apart from :meth:`set_gallery` so that an empty scan arriving there
        is still refused rather than silently deleting one.
        """
        if self.status in ("countdown", "playing"):
            return {"ok": False, "error": "Round already running"}
        if not self._player(player_id):
            return {"ok": False, "error": "Unknown player"}
        self._store_gallery(player_id, [])
        return {"ok": True}

    def _store_gallery(self, player_id, gallery):
        """Give ``player_id``, its owner and its debug clone the same gallery.

        Every gallery write in the room goes through here, and each one moves
        ``gallery_rev`` on, so no path can change a gallery without the revision
        changing with it. That is what the roster delta rests on: a phone told
        revision *n* would otherwise go on matching against a scan that has
        since been replaced - or, after :meth:`clear_gallery`, against one that
        no longer exists at all, because an entry with no ``gallery`` key means
        "keep what you have" (see :func:`backend.transport.roster_for`).
        """
        clone_id = f"{player_id}{CLONE_SUFFIX}"
        for candidate in (player_id, self.clone_owner_id(player_id), clone_id):
            player = self._player(candidate)
            if player is not None:
                player.gallery = gallery
                player.gallery_rev += 1

    def unscanned_players(self):
        """Real players nobody has scanned yet - clones are excluded on purpose,
        since they inherit their owner's gallery."""
        return [
            player
            for player in self.players.values()
            if not self.clone_owner_id(player.id) and not self.mirrored_gallery(player)
        ]

    def reset_round(self):
        self.status = "waiting"
        self.starts_at = None
        self.winner = None
        for player in self.players.values():
            player.hp = MAX_HP
            player.alive = True

    def finish_if_decided(self):
        """End the round once at most one player is left standing.

        Forfeited players have nobody behind them any more, so this is where
        they finally leave the room.
        """
        survivors = [player for player in self.players.values() if player.alive]
        if len(survivors) > 1:
            return
        self.status = "over"
        self.ended_at = self.now()
        self.winner = survivors[0].id if survivors else None
        if self.winner:
            self.players[self.winner].wins += 1
        self.players = {pid: player for pid, player in self.players.items() if not player.forfeited}

    def forfeit(self, player_id):
        """Leave on purpose. Mid-round that counts as a knockout, not a vanish.

        A player still standing in a live round is knocked out and kept on the
        scoreboard as down until the round ends; anywhere else this is a plain
        :meth:`leave`. ``ko`` in the result says which happened.
        """
        self.update()
        player = self._player(player_id)
        if not player:
            return {"ok": False, "error": "Unknown player"}
        if self.status != "playing" or not player.alive:
            self.leave(player_id)
            return {"ok": True, "ko": False}
        player.hp = 0
        player.alive = False
        player.forfeited = True
        player.out_at = self.now()
        self.finish_if_decided()
        return {"ok": True, "ko": True}

    def leave(self, player_id):
        if player_id not in self.players:
            return
        del self.players[player_id]
        if self.status == "playing":
            self.finish_if_decided()
        elif self.status == "countdown" and len(self.players) < MIN_PLAYERS:
            self.reset_round()
        elif self.status == "over" and (not self.winner or self.winner not in self.players):
            self.reset_round()

    def start(self):
        """Begin a countdown, wiping every per-round field the last round set.

        ``gallery`` and ``gallery_rev`` are pointedly *not* among them: a scan
        outlives the round it was taken for, and resetting the revision would
        tell every phone that already holds that scan to keep holding it under a
        number the server has reused (see :func:`backend.transport.roster_for`).
        ``wins`` survives for the same reason - it is the lobby's tally, not the
        round's.
        """
        if self.status in ("countdown", "playing"):
            return {"ok": False, "error": "Round already running"}
        if len(self.players) < MIN_PLAYERS:
            return {"ok": False, "error": "Need at least two players"}
        missing = self.unscanned_players()
        if missing:
            names = ", ".join(player.name for player in missing[:3])
            if len(missing) > 3:
                names += f" +{len(missing) - 3}"
            return {"ok": False, "error": f"Scan everyone before launch: {names}"}
        for player in self.players.values():
            player.hp = MAX_HP
            player.alive = True
            player.stats = RoundStats()
            player.out_at = None
            # Reset with the rest of the per-round state rather than left to the
            # pruning in finish_if_decided: that pruning is the only reason no
            # forfeited player is seated by the time this runs, and a stale flag
            # here would mark a live player as a quitter for the whole round.
            player.forfeited = False
        self.winner = None
        self.started_at = None
        self.ended_at = None
        self.status = "countdown"
        self.starts_at = self.now() + COUNTDOWN_MS
        return {"ok": True}

    def update(self):
        """Promote a finished countdown to ``playing``.

        Nothing schedules this: the room has no clock of its own, so every entry
        point that cares about the current status calls it first.
        """
        if self.status == "countdown" and self.starts_at is not None and self.now() >= self.starts_at:
            self.status = "playing"
            self.started_at = self.starts_at
            self.starts_at = None

    def shoot(self, shooter_id, target_id, zone):
        """Resolve one pull of the trigger.

        ``target_id`` of ``None`` is a shot that hit nobody. It is still checked
        and still counts toward the shooter's ``shots``, which is what makes their
        accuracy real. A shot at someone who is already down (the shooter's phone
        had not heard yet) is a miss the same way. ``hit`` in the result says
        which it was; the rest of the fields are only there for a hit.
        """
        self.update()
        shooter = self._player(shooter_id)
        target = None if target_id is None else self._player(target_id)
        if not shooter or (target_id is not None and not target):
            return {"ok": False, "error": "Unknown player"}
        if target is shooter:
            return {"ok": False, "error": "Can't target yourself"}
        if self.status != "playing":
            return {"ok": False, "error": "Round not running"}
        if not shooter.alive:
            return {"ok": False, "error": "You are down"}
        # isinstance first: an unhashable JSON value (list/dict) as the zone
        # would otherwise raise TypeError out of the dict lookup.
        if target and (not isinstance(zone, str) or zone not in DAMAGE):
            return {"ok": False, "error": "Unknown zone"}

        now = self.now()
        if now - shooter.last_shot_at < SHOT_COOLDOWN_MS - SHOT_COOLDOWN_SLACK_MS:
            return {"ok": False, "error": "Cooldown"}
        shooter.last_shot_at = now
        shooter.stats.shots += 1
        if not target or not target.alive:
            return {"ok": True, "hit": False}

        damage = DAMAGE[zone]
        dealt = min(damage, target.hp)
        target.hp -= dealt
        shooter.stats.hits += 1
        shooter.stats.damage += dealt
        if zone == "head":
            shooter.stats.headshots += 1
        ko = target.hp == 0
        if ko:
            target.alive = False
            target.out_at = now
            shooter.stats.kills += 1
            self.finish_if_decided()
        return {
            "ok": True,
            "hit": True,
            "victimId": target.id,
            "damage": damage,
            "zone": zone,
            "ko": ko,
            "hp": target.hp,
            "alive": target.alive,
        }

    def time_alive_ms(self, player):
        """From the start of the round until it ended for ``player``, or until now."""
        if self.started_at is None:
            return 0
        end = player.out_at if player.out_at is not None else self.ended_at
        if end is None:
            end = self.now()
        return max(0, round(end - self.started_at))

    def snapshot(self):
        """The public scoreboard, safe to send to everyone (no galleries)."""
        self.update()
        return {
            "code": self.code,
            "status": self.status,
            "startsInMs": None if self.starts_at is None else max(0, self.starts_at - self.now()),
            "winner": self.winner,
            "maxHp": MAX_HP,
            "minPlayers": MIN_PLAYERS,
            "maxPlayers": MAX_PLAYERS,
            "players": [
                {
                    "id": player.id,
                    "name": player.name,
                    "hp": player.hp,
                    "wins": player.wins,
                    "alive": player.alive,
                    "forfeited": player.forfeited,
                    "stats": {
                        "kills": player.stats.kills,
                        "damage": player.stats.damage,
                        "shots": player.stats.shots,
                        "hits": player.stats.hits,
                        "headshots": player.stats.headshots,
                        "timeAliveMs": self.time_alive_ms(player),
                    },
                }
                for player in self.players.values()
            ],
        }

    def roster_entry(self, player, gallery=True):
        """One line of the roster, with the heavy part optional.

        An entry without a ``gallery`` key means "whatever you already have for
        this player is still current" - the transport leaves it out for phones it
        has already sent that exact scan to. The identity half (``id``, ``name``)
        is always present, because a phone has to be able to tell who is in the
        room from the roster alone.
        """
        entry = {"id": player.id, "name": player.name}
        if gallery:
            entry["gallery"] = self.mirrored_gallery(player)
        return entry

    def roster(self):
        """Who to look for, with the appearance signatures the phones match on.

        Much heavier than :meth:`snapshot` - one full gallery is roughly 190 KB
        of JSON - so it is only sent when enrolment changes rather than on every
        state tick, and even then only to a phone that does not already have it
        (:func:`backend.transport.roster_for`). This method is the complete
        picture, which is what a freshly connected phone needs.
        """
        return [self.roster_entry(player) for player in self.players.values()]
