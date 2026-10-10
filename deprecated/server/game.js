// Pure game logic for a single room. No networking here, so it can be unit tested.

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MAX_HP = 100;
export const DAMAGE = { body: 20, head: 50 };
export const SHOT_COOLDOWN_MS = 350;
export const COUNTDOWN_MS = 3000;

export class Room {
  constructor(code, { now = Date.now } = {}) {
    this.code = code;
    this.now = now;
    this.players = new Map(); // id -> { id, name, gallery, hp, wins, alive, lastShotAt }
    this.status = 'waiting'; // waiting | countdown | playing | over
    this.startsAt = null;
    this.winner = null;
  }

  get isEmpty() {
    return this.players.size === 0;
  }

  // gallery is the appearance signature captured during enrolment: an array of
  // { hist, grid } samples, one per angle the player was scanned from.
  join(id, name, gallery = []) {
    if (this.status === 'countdown' || this.status === 'playing') {
      return { ok: false, error: 'Lobby is already running.' };
    }
    if (this.players.size >= MAX_PLAYERS) return { ok: false, error: 'Room is full' };
    this.players.set(id, { id, name, gallery: gallery ?? [], hp: MAX_HP, wins: 0, alive: true, lastShotAt: -Infinity });
    return { ok: true };
  }

  cloneOwnerId(id) {
    const suffix = ':debug-clone';
    return typeof id === 'string' && id.endsWith(suffix) ? id.slice(0, -suffix.length) : null;
  }

  mirroredGallery(player) {
    const ownerId = this.cloneOwnerId(player.id);
    return ownerId && this.players.has(ownerId) ? this.players.get(ownerId).gallery : player.gallery;
  }

  setGallery(id, gallery) {
    if (this.status === 'countdown' || this.status === 'playing') {
      return { ok: false, error: 'Round already running' };
    }
    const player = this.players.get(id);
    if (!player) return { ok: false, error: 'Unknown player' };
    if (!gallery?.length) return { ok: false, error: 'Scan did not contain enough samples' };
    player.gallery = gallery;
    const ownerId = this.cloneOwnerId(id);
    if (ownerId && this.players.has(ownerId)) this.players.get(ownerId).gallery = gallery;
    const cloneId = `${id}:debug-clone`;
    if (this.players.has(cloneId)) this.players.get(cloneId).gallery = gallery;
    return { ok: true };
  }

  unscannedPlayers() {
    return [...this.players.values()].filter((p) => !this.cloneOwnerId(p.id) && !this.mirroredGallery(p)?.length);
  }

  resetRound() {
    this.status = 'waiting';
    this.startsAt = null;
    this.winner = null;
    for (const p of this.players.values()) {
      p.hp = MAX_HP;
      p.alive = true;
    }
  }

  finishIfDecided() {
    const survivors = [...this.players.values()].filter((p) => p.alive);
    if (survivors.length > 1) return;
    this.status = 'over';
    this.winner = survivors[0]?.id ?? null;
    if (this.winner) this.players.get(this.winner).wins += 1;
  }

  leave(id) {
    if (!this.players.has(id)) return;
    this.players.delete(id);
    if (this.status === 'playing') {
      this.finishIfDecided();
    } else if (this.status === 'countdown' && this.players.size < MIN_PLAYERS) {
      this.resetRound();
    } else if (this.status === 'over' && (!this.winner || !this.players.has(this.winner))) {
      this.resetRound();
    }
  }

  // Starts a round (first one, or the next one after 'over'). Any joined player can call this.
  start() {
    if (this.status === 'countdown' || this.status === 'playing') {
      return { ok: false, error: 'Round already running' };
    }
    if (this.players.size < MIN_PLAYERS) return { ok: false, error: 'Need at least two players' };
    const missing = this.unscannedPlayers();
    if (missing.length) {
      const names = missing.slice(0, 3).map((p) => p.name).join(', ');
      return { ok: false, error: `Scan everyone before launch: ${names}${missing.length > 3 ? ` +${missing.length - 3}` : ''}` };
    }
    for (const p of this.players.values()) {
      p.hp = MAX_HP;
      p.alive = true;
    }
    this.winner = null;
    this.status = 'countdown';
    this.startsAt = this.now() + COUNTDOWN_MS;
    return { ok: true };
  }

  // Moves countdown -> playing once the start time has passed. Call before reading state.
  update() {
    if (this.status === 'countdown' && this.now() >= this.startsAt) {
      this.status = 'playing';
      this.startsAt = null;
    }
  }

  // The shooter's phone decides who (if anyone) was under the crosshair - vision-based player
  // identification, not just "the one other person in the room" - and tells us the targetId.
  shoot(id, targetId, zone) {
    this.update();
    const shooter = this.players.get(id);
    const target = this.players.get(targetId);
    if (!shooter || !target) return { ok: false, error: 'Unknown player' };
    if (target.id === shooter.id) return { ok: false, error: "Can't target yourself" };
    if (this.status !== 'playing') return { ok: false, error: 'Round not running' };
    if (!shooter.alive || !target.alive) return { ok: false, error: 'Target is down' };
    if (!(zone in DAMAGE)) return { ok: false, error: 'Unknown zone' };

    const t = this.now();
    if (t - shooter.lastShotAt < SHOT_COOLDOWN_MS) return { ok: false, error: 'Cooldown' };
    shooter.lastShotAt = t;

    const damage = DAMAGE[zone];
    target.hp = Math.max(0, target.hp - damage);
    const ko = target.hp === 0;
    if (ko) {
      target.alive = false;
      this.finishIfDecided();
    }
    return { ok: true, victimId: target.id, damage, zone, ko };
  }

  // Frequent broadcast: game state only, no gallery data.
  snapshot() {
    this.update();
    return {
      code: this.code,
      status: this.status,
      startsInMs: this.startsAt === null ? null : Math.max(0, this.startsAt - this.now()),
      winner: this.winner,
      maxHp: MAX_HP,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: [...this.players.values()].map(({ id, name, hp, wins, alive }) => ({ id, name, hp, wins, alive })),
    };
  }

  // Sent only when membership changes: everyone's appearance gallery, for on-device matching.
  roster() {
    return [...this.players.values()].map((player) => ({ id: player.id, name: player.name, gallery: this.mirroredGallery(player) }));
  }
}
