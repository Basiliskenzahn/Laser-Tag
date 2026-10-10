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

// The server sends the roster as a delta. Membership is always complete, so the entries are the
// room, full stop; what's conditional is the heavy part. A player's `gallery` key is present only
// when their scan changed since this connection last heard about them, and an entry without one
// means "keep the gallery you already have". One gallery is ~190 KB, so re-sending all of them to
// everyone on every scan used to cost the room N x N copies of that (see docs/server/protocol.md).
//
// Nothing here has to cope with a missed or out-of-order delta: the server tracks what it put on
// *this* connection's wire, and any way of losing a message drops the connection, after which the
// reconnect is sent the roster in full. A player we've never seen and whose gallery was withheld
// can therefore only be someone nobody has scanned yet, which is what an empty gallery means
// everywhere else too.
//
// That rests on one invariant, and it is the only way to break this: `state.roster` must never be
// thrown away while the connection that filled it is still open, or the server would go on
// withholding galleries this phone no longer has. Today the single place that clears it,
// `leaveLobby()`, closes the connection in the same breath. Anything new that wants to reset the
// roster must close the connection too (or ask for a fresh one).
export function mergeRoster(previous, entries) {
  return entries.map((entry) => {
    if (entry.gallery !== undefined) return entry;
    return { ...entry, gallery: previous.find((player) => player.id === entry.id)?.gallery ?? [] };
  });
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
