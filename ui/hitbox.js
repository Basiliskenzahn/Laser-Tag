// Draws detected people as hitboxes on a canvas, in the Laser Tag style:
// a solid box around the person, a dashed head box, and the detection confidence.
// Colours and line width come from tokens.css, so restyling happens there.
//
// Box format, in video pixel coordinates (whatever the detection code produces):
//   { x, y, w, h, score?, head?: { x, y, w, h }, targeted?: boolean }
// `targeted` boxes are drawn in the target colour, the rest in the idle colour.

// Maps video pixels to screen pixels the same way CSS `object-fit: cover` does.
export function coverTransform(videoWidth, videoHeight, viewWidth, viewHeight) {
  const scale = Math.max(viewWidth / videoWidth, viewHeight / videoHeight);
  return {
    scale,
    offsetX: (viewWidth - videoWidth * scale) / 2,
    offsetY: (viewHeight - videoHeight * scale) / 2,
  };
}

// Sizes the canvas for the screen's pixel density and clears it.
export function prepareCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

let tokens = null;

function readTokens() {
  if (tokens) return tokens;
  const css = getComputedStyle(document.documentElement);
  const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  tokens = {
    idle: get('--hitbox-idle', '#39ff88'),
    target: get('--hitbox-target', '#ff2e4d'),
    lineWidth: parseFloat(get('--hitbox-line', '3')),
    font: `600 13px ${get('--font-sans', 'system-ui, sans-serif')}`,
  };
  return tokens;
}

// Clears the canvas and draws every box. Call once per frame.
export function drawHitboxes(canvas, boxes, { videoWidth, videoHeight }) {
  const { ctx, width, height } = prepareCanvas(canvas);
  if (!videoWidth || !videoHeight) return;

  const { scale, offsetX, offsetY } = coverTransform(videoWidth, videoHeight, width, height);
  const toScreen = (r) => [offsetX + r.x * scale, offsetY + r.y * scale, r.w * scale, r.h * scale];
  const style = readTokens();

  ctx.lineWidth = style.lineWidth;
  ctx.font = style.font;
  for (const box of boxes) {
    const color = box.targeted ? style.target : style.idle;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    ctx.setLineDash([]);
    ctx.strokeRect(...toScreen(box));

    if (box.head) {
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(...toScreen(box.head));
    }

    if (box.score != null) {
      const [x, y] = toScreen(box);
      ctx.fillText(`${Math.round(box.score * 100)}%`, x + 4, y + 16);
    }
  }
  ctx.setLineDash([]);
}
