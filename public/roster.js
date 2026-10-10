// Questions about the other players, answered from the last roster and game snapshot the server
// sent. The server owns the truth about who is in the room, who still has hit points and whose
// scan has arrived; these are the small read-only lookups the screens and the frame loop ask
// over and over.
//
// localSelfId() belongs here because "me" is only known once the server says welcome, and the
// matcher needs a stable stand-in id before that so it can still recognise the phone's owner and
// refuse to shoot them.

import { state } from './state.js';

export function localSelfId() {
  return state.myId ?? '__local-self';
}

export function gamePlayer(playerId) {
  return state.game?.players.find((player) => player.id === playerId) ?? null;
}

export function isAlivePlayer(playerId) {
  return gamePlayer(playerId)?.alive === true;
}

export function isDeadPlayer(playerId) {
  return gamePlayer(playerId)?.alive === false;
}

export function scannedGallery(playerId) {
  return state.roster.find((player) => player.id === playerId)?.gallery ?? [];
}

export function cloneOwnerId(playerId) {
  const suffix = ':debug-clone';
  return typeof playerId === 'string' && playerId.endsWith(suffix) ? playerId.slice(0, -suffix.length) : null;
}

export function playerName(playerId) {
  return (
    state.roster.find((player) => player.id === playerId)?.name ??
    state.game?.players?.find((player) => player.id === playerId)?.name ??
    'player'
  );
}

export function hasScan(player) {
  return Boolean(player.gallery?.length);
}

export function missingScanPlayers() {
  const players = state.game?.players ?? state.roster;
  return players.filter((player) => !cloneOwnerId(player.id) && !scannedGallery(player.id).length);
}

export function matchingRoster() {
  const selfId = localSelfId();
  const roster = state.roster.filter((player) => player.id !== selfId);
  if (!state.localGallery.length) return roster;
  const self = { id: selfId, name: 'Person', gallery: state.localGallery };
  return [...roster, self];
}

export function rosterCandidateCount() {
  const ids = new Set();
  for (const player of state.roster) {
    if (player.gallery?.length) ids.add(player.id);
  }
  if (state.localGallery.length) ids.add(localSelfId());
  return ids.size;
}
