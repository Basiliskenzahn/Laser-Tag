# HUD, sound and feedback

What players see and hear, and where it's implemented.

## HUD

`renderHud()` in `screens/game.js` rebuilds the top bar from each `state` message:

- One entry per player: name (with "(you)", or "(left)" for a player who forfeited), a ★ win counter once they've won a round, and an HP bar. Yours always comes first, full width beside the Leave button; everyone else follows in join order in a compact grid (two rows of four for a full room of 8 on a phone, one row on a wider screen). The bar turns to its "low" style at 30% HP or below. Knocked-out players are styled as down.
- Rows are kept per player rather than rebuilt, so when a player's HP drops their bar can react: the fill snaps down, the lost HP stays as a white chip for a moment and then drains away, and the bar gives a very small shake (`setHealth()`).
- A banner below shows status text: connection problems, *"Waiting for more players…"*, *"You are down"*, or the winner.
- There is no fire button: a tap anywhere but a button fires. The banner's **Start game** / **Play again** button only shows while the room is `waiting` or `over`.

The countdown is drawn every frame by `updateCountdown()`: **3, 2, 1, GO!** (the countdown is `GAME_LAUNCH_COUNTDOWN_MS`, 3 s, and then whatever `startsInMs` the server reports), with *"GO!"* staying up briefly after play starts. Each new number plays a beep; *"GO!"* gets a longer, higher one.

## Track outlines

`drawGame()` draws every track seen in the last 520 ms. The label and colour come from the identity the provider resolved:

| Look | Meaning |
| --- | --- |
| Solid green outline, name label | Identified player, alive |
| Red | The targetable player under the crosshair |
| Grey, sparse dashes, "*name* down" | Identified player who is knocked out |
| Grey, dashed, "Person" | Not identified |
| Yellow, long dashes, "*name*? 0.51" | Debug mode only: the best rejected match and its score |

Alive and unidentified tracks also show the **body** hitbox (solid) and **head** hitbox (dashed). The crosshair element gets the `on-target` class whenever a targetable player is under it.

On the scan screen, `drawScan()` outlines every detected person, with the one the scan would use in green.

## Sound

`frontend/public/sound.js` synthesises every effect with the Web Audio API, so there are no audio files.

| Function | When | Sound |
| --- | --- | --- |
| `unlock()` | Tapping **Create Room** or **Join**, then every tap/click/key | Creates the audio context and resumes it if it isn't running. Browsers block audio until a user gesture, and iOS suspends the context again when the camera starts or the page is hidden. |
| `shoot()` | Every shot | Falling square-wave "pew" |
| `hitConfirmed(headshot)` | Your hit landed | Short sine ping, a second higher ping for headshots |
| `hurt()` | You got hit | Low sawtooth buzz |
| `countdownBeep(final)` | Each countdown number | Short beep, longer higher beep on GO |
| `win()` / `lose()` | Results screen opens (you won / you were knocked out or lost), or a round this phone saw running ends while it's on another screen. Never on joining or reconnecting to a room whose last round is still `over`. | Rising four-note / falling three-note jingle |
| `statTicks(count, start, step)` | Results screen, one per stat line as it appears | Short, quiet sine ticks rising in pitch |

All of them go through one helper, `tone({type, from, to, duration, volume, delay})`.

## Other feedback

| Event | Effect | Code |
| --- | --- | --- |
| Your hit landed | Crosshair `hit` animation and a floating popup: `−20` or `HEADSHOT −50` | `popup()`, `restartAnimation()` |
| Your hit landed | The target's health bar appears over their head, follows them, shows the drop the same way the HUD does, and fades after about 1.5 s | `showHitBar()`, placed each frame by `drawGame()` |
| You got hit | Full-screen red `flash`, and vibration: 120 ms for a body hit, a pattern for a headshot | `navigator.vibrate` (not supported on iOS) |
| You fired (tap anywhere but a button) | Crosshair `firing` recoil: kicks up 10px and settles back | `restartAnimation()` |
| You fired | A short grey bar under the crosshair whose white fill drains to the left over the fire cooldown (`FIRE_COOLDOWN_MS`, 350 ms), then disappears | `#cooldown.cooling`, set in `fire()` |

Styles and animations live in `frontend/public/style.css`.
