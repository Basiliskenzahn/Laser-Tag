// Pure game logic for a single room. No networking here, so it can be unit tested.

export const MAX_PLAYERS = 2;
export const MAX_HP = 100;
export const DAMAGE = { body: 20, head: 50 };
export const SHOT_COOLDOWN_MS = 350;
export const COUNTDOWN_MS = 3000;

export class Room {
  constructor(code, { now = Date.now } = {}) {
    this.code = code;
    this.now = now;
    this.players = new Map(); // id -> { id, name, hp, wins, lastShotAt }
    this.status = 'waiting'; // waiting | countdown | playing | over
    this.startsAt = null;
    this.winner = null;
  }

  get isEmpty() {
    return this.players.size === 0;
  }

  join(id, name) {
    if (this.players.size >= MAX_PLAYERS) {
      return { ok: false, error: 'Room is full' };
    }
    this.players.set(id, { id, name, hp: MAX_HP, wins: 0, lastShotAt: -Infinity });
    if (this.players.size === MAX_PLAYERS) this.startCountdown();
    return { ok: true };
  }

  leave(id) {
    this.players.delete(id);
    // The remaining player waits for a new opponent with a fresh round.
    this.status = 'waiting';
    this.startsAt = null;
    this.winner = null;
    for (const p of this.players.values()) p.hp = MAX_HP;
  }

  startCountdown() {
    for (const p of this.players.values()) p.hp = MAX_HP;
    this.winner = null;
    this.status = 'countdown';
    this.startsAt = this.now() + COUNTDOWN_MS;
  }

  // Moves countdown -> playing once the start time has passed. Call before reading state.
  update() {
    if (this.status === 'countdown' && this.now() >= this.startsAt) {
      this.status = 'playing';
      this.startsAt = null;
    }
  }

  opponentOf(id) {
    for (const p of this.players.values()) if (p.id !== id) return p;
    return null;
  }

  // The shooter's phone decides whether the crosshair was on a person; the server applies it.
  shoot(id, zone) {
    this.update();
    const shooter = this.players.get(id);
    const victim = this.opponentOf(id);
    if (!shooter || !victim) return { ok: false, error: 'No opponent' };
    if (this.status !== 'playing') return { ok: false, error: 'Round not running' };
    if (!(zone in DAMAGE)) return { ok: false, error: 'Unknown zone' };

    const t = this.now();
    if (t - shooter.lastShotAt < SHOT_COOLDOWN_MS) return { ok: false, error: 'Cooldown' };
    shooter.lastShotAt = t;

    const damage = DAMAGE[zone];
    victim.hp = Math.max(0, victim.hp - damage);
    const ko = victim.hp === 0;
    if (ko) {
      shooter.wins += 1;
      this.status = 'over';
      this.winner = shooter.id;
    }
    return { ok: true, victimId: victim.id, damage, zone, ko };
  }

  rematch() {
    if (this.status === 'over' && this.players.size === MAX_PLAYERS) this.startCountdown();
  }

  snapshot() {
    this.update();
    return {
      code: this.code,
      status: this.status,
      startsInMs: this.startsAt === null ? null : Math.max(0, this.startsAt - this.now()),
      winner: this.winner,
      maxHp: MAX_HP,
      players: [...this.players.values()].map(({ id, name, hp, wins }) => ({ id, name, hp, wins })),
    };
  }
}
