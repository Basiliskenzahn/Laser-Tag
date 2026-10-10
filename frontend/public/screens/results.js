// The end of your round: a flash, then your placing and your stats over the live camera.
//
// It opens the moment the round is over for you - knocked out mid-round, or the round ending
// while you are still up - and stays until you pick "Done" (back to the lobby) or "Rematch".
// Detection stops while it is up (state.mode is 'results'), but the camera keeps running behind
// it. The flash, the fade to dark and the line-by-line reveal are all CSS animations; this
// module only fills the text in and sets each line's delay.

import { $ } from '../env.js';
import { state } from '../state.js';
import * as sound from '../sound.js';
import { closeLeaveDialog } from './game.js';
import { launchGame, showLobby } from './lobby.js';

// Placeholder numbers until the server tracks per-player stats.
const PLACEHOLDER_STATS = [
  ['Kills', '3'],
  ['Damage dealt', '240'],
  ['Shots fired', '41'],
  ['Accuracy', '37%'],
  ['Headshots', '5'],
  ['Time alive', '2:14'],
];

// Reveal timing, in ms from the moment the screen opens. The flash itself lasts 800ms.
const RANK_AT = 450;
const FIRST_STAT_AT = 850;
const STAT_STEP = 110;

export function showResults(game) {
  const won = game.status === 'over' && game.winner === state.myId;
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
  PLACEHOLDER_STATS.forEach(([label, value], i) => {
    const row = document.createElement('div');
    row.style.animationDelay = `${FIRST_STAT_AT + i * STAT_STEP}ms`;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    row.append(dt, dd);
    list.append(row);
  });
  const footerAt = `${FIRST_STAT_AT + PLACEHOLDER_STATS.length * STAT_STEP + 150}ms`;
  $('results-status').style.animationDelay = footerAt;
  $('results-actions').style.animationDelay = footerAt;

  updateResults(game);
  results.hidden = false; // coming out of display: none replays every animation from the start

  won ? sound.win() : sound.lose();
  sound.statTicks(PLACEHOLDER_STATS.length, FIRST_STAT_AT / 1000, STAT_STEP / 1000);
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

export function hideResults() {
  $('results').hidden = true;
  $('game-screen').classList.remove('show-results');
}

// Through the lobby, so a missing scan or a refused start lands somewhere that can show it.
export function rematch() {
  showLobby();
  launchGame();
}
