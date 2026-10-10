# HUD, sound and feedback

What players see and hear, and where it's implemented.

## HUD

`renderHud()` in `app.js` rebuilds the top bar from each `state` message:

- One row per player: name (with "(you)"), a ★ win counter once they've won a round, and an HP bar. The bar turns to its "low" style at 30% HP or below. Knocked-out players are styled as down.
- A banner below shows status text: connection problems, *"Waiting for more players…"*, *"You are down"*, or the winner.
- The **FIRE** button only appears while the round is playing and you're alive.

The countdown is drawn every frame by `updateCountdown()`: **5, 4, 3, 2, 1, GO!**, with *"GO!"* staying up briefly after play starts.

## Track outlines

`drawGame()` draws every track seen in the last 520 ms:

| Look | Meaning |
| --- | --- |
| Solid green outline, name label | Identified player, alive |
| Red | The targetable player under the crosshair |
| Grey, sparse dashes, "*name* down" | Identified player who is knocked out |
| Grey, dashed, "Person" | Not identified |
| Yellow, long dashes, "*name*? 0.51" | Debug mode only: the best rejected match and its score |

Alive and unidentified tracks also show the **body** hitbox (solid) and **head** hitbox (dashed). The crosshair element gets the `on-target` class whenever a targetable player is under it.

On the scan screen, `drawScan()` outlines every detected person, with the one that would be captured in green.

## Sound

`public/sound.js` synthesises every effect with the Web Audio API, so there are no audio files.

| Function | When | Sound |
| --- | --- | --- |
| `unlock()` | Tapping **Continue** | Creates/resumes the audio context. Browsers block audio until a user gesture. |
| `shoot()` | Every shot | Falling square-wave "pew" |
| `hitConfirmed(headshot)` | Your hit landed | Short sine ping, a second higher ping for headshots |
| `hurt()` | You got hit | Low sawtooth buzz |
| `countdownBeep(final)` | Each countdown number | Short beep, longer higher beep on GO |
| `win()` / `lose()` | Round over | Rising four-note / falling three-note jingle |

All of them go through one helper, `tone({type, from, to, duration, volume, delay})`.

## Other feedback

| Event | Effect | Code |
| --- | --- | --- |
| Your hit landed | Crosshair `hit` animation and a floating popup: `−20` or `HEADSHOT −50` | `popup()`, `restartAnimation()` |
| You got hit | Full-screen red `flash`, and vibration: 120 ms for a body hit, a pattern for a headshot | `navigator.vibrate` (not supported on iOS) |
| You fired | FIRE button `firing` animation | |

Styles and animations live in `public/style.css`.
