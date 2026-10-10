// The end of your round: a flash, then your placing and your stats over the live camera.
//
// It opens once the round is over for you - knocked out mid-round, or the round ending while you
// are still up - just after the shot that did it has played out, and stays until you pick "Done" (back to the lobby) or "Rematch".
// Detection stops while it is up (state.mode is 'results'), but the camera keeps running behind
// it. The flash, the fade to dark and the line-by-line reveal are all CSS animations; this
// module only fills the text in and sets each line's delay.

import { $ } from '../env.js';
import { state } from '../state.js';
import * as sound from '../sound.js';
import { closeLeaveDialog } from './game.js';
import { launchGame, showLobby } from './lobby.js';

// Your round in numbers, from the stats the server keeps for each player (models.RoundStats).
function statLines(me) {
  const s = me?.stats ?? { kills: 0, damage: 0, shots: 0, hits: 0, headshots: 0, timeAliveMs: 0 };
  return [
    ['Kills', String(s.kills)],
    ['Damage dealt', String(s.damage)],
    ['Shots fired', String(s.shots)],
    ['Accuracy', s.shots ? `${Math.round((s.hits / s.shots) * 100)}%` : '–'],
    ['Headshots', String(s.headshots)],
    ['Time alive', formatDuration(s.timeAliveMs)],
  ];
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Reveal timing, in ms from the moment the screen opens. The flash itself lasts 800ms.
const RANK_AT = 450;
const FIRST_STAT_AT = 850;
const STAT_STEP = 110;
// How long the shot that ended your round (hitmarker, damage number, red flash) stays on screen
// before the results cover it. Hiding them mid-animation would also leave them to replay later.
const FINAL_HIT_MS = 400;

let pendingGame = null; // the latest state while the final hit is still showing
let pendingTimer = null;

// The round is over for us: let the final hit land, then open the results with the newest state.
export function showResultsSoon(game) {
  pendingGame = game;
  pendingTimer ??= setTimeout(() => {
    const latest = pendingGame;
    cancelPendingResults();
    showResults(latest);
  }, FINAL_HIT_MS);
}

function cancelPendingResults() {
  clearTimeout(pendingTimer);
  pendingTimer = null;
  pendingGame = null;
}

export function showResults(game) {
  const won = game.status === 'over' && game.winner === state.myId;
  const stats = statLines(game.players.find((p) => p.id === state.myId));
  // Everyone still standing finishes ahead of you; the winner is always #1.
  const rank = won ? 1 : game.players.filter((p) => p.alive && p.id !== state.myId).length + 1;

  state.mode = 'results';
  closeLeaveDialog();
  $('game-screen').classList.add('show-results');

  const results = $('results');
  results.classList.toggle('win', won);
  const rankEl = $('results-rank');
  rankEl.textContent = `#${rank}`;
  rankEl.className = rank <= 3 ? `rank-${rank}` : '';
  rankEl.style.animationDelay = `${RANK_AT}ms`;
  $('results-title').textContent = won ? 'Winner' : 'Knocked out';
  $('results-title').style.animationDelay = `${RANK_AT + 150}ms`;

  const list = $('results-stats');
  list.innerHTML = '';
  stats.forEach(([label, value], i) => {
    const row = document.createElement('div');
    row.style.animationDelay = `${FIRST_STAT_AT + i * STAT_STEP}ms`;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    row.append(dt, dd);
    list.append(row);
  });
  const footerAt = `${FIRST_STAT_AT + stats.length * STAT_STEP + 150}ms`;
  $('results-status').style.animationDelay = footerAt;
  $('results-actions').style.animationDelay = footerAt;

  updateResults(game);
  results.hidden = false; // coming out of display: none replays every animation from the start

  won ? sound.win() : sound.lose();
  sound.statTicks(stats.length, FIRST_STAT_AT / 1000, STAT_STEP / 1000);
}

// A rematch can only start once the round is over for everyone, not just for you.
export function updateResults(game) {
  const running = game.status === 'countdown' || game.status === 'playing';
  const winner = game.players.find((p) => p.id === game.winner);
  $('results-rematch-btn').disabled = running;
  $('results-status').textContent = running
    ? 'Waiting for the round to end…'
    : game.status === 'over' && game.winner !== state.myId
      ? `${winner?.name ?? 'Nobody'} wins`
      : '';
}

// Also drops a results screen that is still waiting on the final hit, since every way off the
// game screen comes through here.
export function hideResults() {
  cancelPendingResults();
  $('results').hidden = true;
  $('game-screen').classList.remove('show-results');
}

// Through the lobby, so a missing scan or a refused start lands somewhere that can show it.
export function rematch() {
  showLobby();
  launchGame();
}
