// Draws detected people as hitboxes on a canvas, in the Laser Tag style:
// a solid box around the person, a dashed head box, and the detection confidence.
// Colours and line widths come from tokens.css, so restyling happens there.
//
// Box format, in video pixel coordinates (whatever the detection code produces):
//   { x, y, w, h, score?, head?: { x, y, w, h }, targeted?: boolean }
// `targeted` boxes are drawn thicker and in the target colour, the rest in the idle colour.

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
    line: parseFloat(get('--hitbox-line', '3')),
    lineTarget: parseFloat(get('--hitbox-line-target', '4')),
    halo: get('--hitbox-halo', 'rgba(0, 0, 0, 0.55)'),
    labelBg: get('--hitbox-label-bg', 'rgba(11, 15, 20, 0.8)'),
    font: `600 13px ${get('--font-sans', 'system-ui, sans-serif')}`,
  };
  return tokens;
}

// A coloured line over a wider dark one, so it stays visible on light and dark backgrounds.
function strokeWithHalo(ctx, rect, color, width, halo, dash) {
  ctx.setLineDash(dash);
  ctx.strokeStyle = halo;
  ctx.lineWidth = width + 3;
  ctx.strokeRect(...rect);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.strokeRect(...rect);
}

// Clears the canvas and draws every box. Call once per frame.
export function drawHitboxes(canvas, boxes, { videoWidth, videoHeight }) {
  const { ctx, width, height } = prepareCanvas(canvas);
  if (!videoWidth || !videoHeight) return;

  const { scale, offsetX, offsetY } = coverTransform(videoWidth, videoHeight, width, height);
  const toScreen = (r) => [offsetX + r.x * scale, offsetY + r.y * scale, r.w * scale, r.h * scale];
  const style = readTokens();
  ctx.font = style.font;
  ctx.textBaseline = 'middle';

  for (const box of boxes) {
    const color = box.targeted ? style.target : style.idle;
    const line = box.targeted ? style.lineTarget : style.line;
    const rect = toScreen(box);

    strokeWithHalo(ctx, rect, color, line, style.halo, []);
    if (box.head) strokeWithHalo(ctx, toScreen(box.head), color, line, style.halo, [6, 4]);

    if (box.score != null) {
      // Tag sits on top of the box, or just inside it when the box touches the top edge.
      const text = `${Math.round(box.score * 100)}%`;
      const labelHeight = 20;
      const x = rect[0] - line / 2;
      const above = rect[1] - line / 2 - labelHeight;
      const y = above >= 0 ? above : rect[1] + line;
      const labelWidth = ctx.measureText(text).width + 10;
      ctx.fillStyle = style.labelBg;
      ctx.fillRect(x, y, labelWidth, labelHeight);
      ctx.fillStyle = color;
      ctx.fillText(text, x + 5, y + labelHeight / 2 + 0.5);
    }
  }
  ctx.setLineDash([]);
}
