// Surfers of India crew studio — preview worker.
// Blurs, watermarks and encodes one photo (WebP where the browser can, JPEG otherwise) off the main
// thread so a 30-photo batch never
// stalls the studio UI. admin.js runs two of these (createPreviewPool) and falls back to its own
// watermarkedPreviewOnMainThread() when Workers/OffscreenCanvas are missing or a file (HEIC on
// some browsers) fails to decode here. KEEP THE CONSTANTS AND DRAWING STEPS BELOW IDENTICAL TO
// admin.js — tests/review-images.test.mjs checks the constants and stamp paths match.
'use strict';

// Guests see this preview until they pay, so it is deliberately useless anywhere else: 600 px on
// the long edge, blurred, then a dense low-alpha diagonal text lattice drawn sharp on top so it can't
// be cropped away, plus the brand stamp in the corner so shares look branded rather than "sample".
// A surfer can still tell it's them; nobody can print it. A 320 px thumbnail (drawn from the
// finished canvas) rides along so grids don't load the 600 px file.
const PREVIEW_MAX = 600;
const PREVIEW_BLUR_PX = 2.2;
const PREVIEW_QUALITY = 0.72;
const THUMB_MAX = 320;
const THUMB_QUALITY = 0.74;
// The wave-crest stamp (soi-stamps.svg #stamp-wave, viewBox 0 0 100 100) as Path2D — no raster asset.
const STAMP_PATHS = [
  'M8 78c10-3 18-2 28-8 8-5 13-13 12-24-1-9-8-17-18-18 12-4 26 1 31 13 4 10 1 22-6 30 9-2 16-8 20-16 5-11 2-24-6-32 14 4 24 17 22 33-2 17-16 29-33 30 6 0 12-1 18-3-9 6-21 8-32 6-12-2-24-3-36-1z',
  'M6 86h60c2 0 2 3 0 3H6c-2 0-2-3 0-3zm10 6h34c2 0 2 3 0 3H16c-2 0-2-3 0-3z',
].map(d => new Path2D(d));

// WebP where the browser really encodes it (Chrome, Firefox, Safari 16+), JPEG otherwise: Safari 15
// and older answer a PNG to a WebP request, so the produced blob's own type is what decides — never a
// UA string. Probed once per worker on the first real preview (the probe result is the preview).
let webpOk = null;
async function encodeWebp(canvas, quality) {
  if (webpOk === false) return null;
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality }).catch(() => null);
  webpOk = Boolean(blob) && blob.type === 'image/webp';
  return webpOk ? blob : null;
}

const fitWithin = (width, height, max) => {
  const scale = Math.min(1, max / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
};
// createImageBitmap downsamples *during* decode, so a 24 MP frame is never allocated. The width comes
// with the job: admin.js reads the file's header (decodeWidth) and never asks for more than the image
// has, so a small file that happens to be heavy is not upscaled; no width means decode at natural size.
const decode = (file, resizeWidth) => createImageBitmap(file, resizeWidth ? { resizeWidth, resizeQuality: 'high' } : {});

// 1) blur, before the watermark. Canvas filters where supported; the image bleeds past the edges
// so the filter's transparent falloff lands off-canvas instead of becoming a dark JPEG border.
// Elsewhere a cheap box blur: draw at 1/3 size and scale back up.
function paintBlurred(ctx, img, width, height) {
  if ('filter' in ctx) {
    const bleed = Math.ceil(PREVIEW_BLUR_PX * 3);
    ctx.filter = `blur(${PREVIEW_BLUR_PX}px)`;
    ctx.drawImage(img, -bleed, -bleed, width + bleed * 2, height + bleed * 2);
    ctx.filter = 'none';
  } else {
    const scratch = new OffscreenCanvas(Math.max(1, Math.round(width / 3)), Math.max(1, Math.round(height / 3)));
    scratch.getContext('2d').drawImage(img, 0, 0, scratch.width, scratch.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scratch, 0, 0, width, height);
  }
}
// 2) anti-crop lattice, sharp on top of the blur; 3) corner stamp: 11% of the width, padded by
// 35% of itself, bottom-right. (Workers have no web fonts, so the lattice sets in Arial here.)
function paintWatermark(ctx, width, height) {
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-Math.PI / 7);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const size = Math.max(16, Math.round(width / 22));
  ctx.font = `700 ${size}px "Plus Jakarta Sans", Arial, sans-serif`;
  const stepY = size * 3.4, stepX = size * 10, reach = Math.hypot(width, height);
  let row = 0;
  for (let y = -reach; y <= reach; y += stepY, row += 1) {
    for (let x = -reach + (row % 2 ? stepX / 2 : 0); x <= reach; x += stepX) {
      ctx.globalAlpha = .22; ctx.fillStyle = '#2B2018'; ctx.fillText('SURFERS OF INDIA · PREVIEW', x + 1, y + 1);
      ctx.globalAlpha = .42; ctx.fillStyle = '#F2ECDB'; ctx.fillText('SURFERS OF INDIA · PREVIEW', x, y);
    }
  }
  ctx.restore();
  const s = Math.round(width * .11), pad = Math.round(s * .35);
  ctx.save();
  ctx.translate(width - s - pad, height - s - pad); ctx.scale(s / 100, s / 100);
  ctx.globalAlpha = .82; ctx.fillStyle = '#F2ECDB'; ctx.shadowColor = 'rgba(43,32,24,.45)'; ctx.shadowBlur = s * .15;
  STAMP_PATHS.forEach(path => ctx.fill(path));
  ctx.restore();
}

async function renderPreview(file, resizeWidth) {
  const img = await decode(file, resizeWidth);
  const [width, height] = fitWithin(img.width, img.height, PREVIEW_MAX);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  paintBlurred(ctx, img, width, height);
  img.close();                                    // release the decoded bitmap right away
  paintWatermark(ctx, width, height);
  const preview = await encodeWebp(canvas, PREVIEW_QUALITY) || await canvas.convertToBlob({ type: 'image/jpeg', quality: PREVIEW_QUALITY });
  const [thumbWidth, thumbHeight] = fitWithin(width, height, THUMB_MAX);
  const small = new OffscreenCanvas(thumbWidth, thumbHeight);
  const smallCtx = small.getContext('2d'); smallCtx.imageSmoothingQuality = 'high';
  smallCtx.drawImage(canvas, 0, 0, thumbWidth, thumbHeight);
  const thumb = await encodeWebp(small, THUMB_QUALITY) || await small.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY });
  return { preview, thumb, width, height };
}

// A tiny thumbnail for the upload list (never uploaded): decode straight to ~`size` px wide and
// hand it back as a data: URL. A ~3 KB string costs the main thread nothing, whereas a Blob would
// need URL.createObjectURL there — a synchronous browser-process round trip that measured ~20 ms
// per thumbnail while twelve uploads were streaming.
async function renderQueueThumb(file, size, resizeWidth) {
  const img = await decode(file, resizeWidth);
  const [width, height] = fitWithin(img.width, img.height, size);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  img.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return { thumb: new FileReaderSync().readAsDataURL(blob), width, height };
}

self.onmessage = async ({ data }) => {
  const { id, kind, file, size, resizeWidth } = data || {};
  try {
    const result = kind === 'thumb' ? await renderQueueThumb(file, size || 96, resizeWidth) : await renderPreview(file, resizeWidth);
    self.postMessage({ id, ...result });
  } catch (error) {
    self.postMessage({ id, error: (error && error.message) || "Couldn't read this file." });
  }
};
