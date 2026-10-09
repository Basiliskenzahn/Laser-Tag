# Laser Tag UI kit

The look of the game, separate from the game code. It's plain CSS plus one small JavaScript module, with no build step and no dependencies.

| File | What it is |
| --- | --- |
| `tokens.css` | Every colour, font, size, spacing and timing. Change the look here. |
| `fonts/` | Geist and Geist Mono, bundled so the game looks right without internet (SIL Open Font License). |
| `components.css` | Styles for every UI piece: buttons, cards, lists, HUD, crosshair, popups, banners and the FIRE button. |
| `hitbox.js` | Draws detected people as hitboxes on a canvas. |
| `index.html` | Style guide showing every component. |
| `screens/*.html` | Static mockups of the join, lobby, in-game and result screens with placeholder content. Copy markup from here. |

## Preview

Browsers block JavaScript modules on `file://` pages, so serve the folder:

```bash
python3 -m http.server -d ui 8000
```

Then open http://localhost:8000. On the in-game screen, tap anywhere to toggle whether the crosshair is on the person, and tap FIRE to see the shot effects.

## Using it in the app

```html
<link rel="stylesheet" href="ui/tokens.css" />
<link rel="stylesheet" href="ui/components.css" />
```

The fonts load from `ui/fonts/` through `tokens.css`, so keep the folder structure when copying the kit.

### Game screen structure

`screens/game.html` shows the full structure. Layers, back to front:

```html
<main class="game">
  <video class="game__camera" playsinline muted autoplay></video>
  <canvas class="game__overlay"></canvas>   <!-- hitboxes, drawn by hitbox.js -->
  <div class="damage-flash"></div>
  <div class="crosshair"></div>
  <div class="popups"></div>
  <header class="hud">…</header>
  <div class="banner">…</div>
  <div class="game__controls"><button class="fire-btn">FIRE</button></div>
</main>
```

### States the game code toggles

| Element | Class / property | When |
| --- | --- | --- |
| `.crosshair` | `.is-on-target` | A hitbox is under the crosshair |
| `.crosshair` | `.is-hit` | A shot landed (re-add to replay) |
| `.fire-btn` | `.is-firing` | Each shot (re-add to replay) |
| `.fire-btn` | `disabled` | During the shot cooldown |
| `.damage-flash` | `.is-active` | The player got hit (re-add to replay) |
| `.hp__fill` | `style.width = '<n>%'`, `.is-low` | Health changes; `.is-low` at 30% or less |
| `.popups` | append `<div class="popup">−20</div>` (`.popup--headshot` for headshots) | A shot landed; remove it on `animationend` |
| `.banner` | `hidden`; `.banner__text--countdown` for the 3-2-1 | Waiting, countdown, round over |
| `.hp` | `aria-valuenow` | Keep in sync with the health shown, for screen readers |
| `.btn` | `aria-busy="true"` plus `disabled` | Shows a spinner, e.g. while the camera and detector start |
| `.input` | `aria-invalid="true"` | Red border for a rejected value, e.g. a full room |
| `.notice` / `.notice--error` | `hidden` | Status or error message on the join screen |

To replay an animation, remove the class, force a reflow with `el.offsetWidth`, then add the class again.

In landscape, the FIRE button moves to the right edge, under the thumb, so it doesn't cover the crosshair. That's handled in CSS.

Room codes are displayed in capitals (`.room-code`, and the room input capitalises as you type), so compare codes case-insensitively on the server.

### Hitboxes

```js
import { drawHitboxes } from './ui/hitbox.js';

// Every frame, with boxes in video pixel coordinates:
drawHitboxes(canvas, [
  { x, y, w, h, score: 0.94, head: { x, y, w, h }, targeted: true },
], { videoWidth: video.videoWidth, videoHeight: video.videoHeight });
```

- Boxes with `targeted: true` are drawn thicker and in `--hitbox-target` (red), the rest in `--hitbox-idle` (green). The thickness difference means targeting doesn't rely on colour alone, for colour-blind players.
- Every line has a dark outline, so boxes stay visible on light walls as well as dark clothing.
- `head` and `score` are optional. The score tag sits on top of the box.
- The mapping from video to screen matches `object-fit: cover`, so the boxes line up with the `.game__camera` video.
