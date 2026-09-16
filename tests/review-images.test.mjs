import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
const loaderSource = source.slice(source.indexOf('function createReviewImageLoader()'), source.indexOf('async function drawCroppedFaceCanvas('));
function setup() {
  const requests = [];
  class Image { set src(url) { requests.push({ url, image: this }); } }
  const load = vm.runInNewContext(`${loaderSource}\ncreateReviewImageLoader()`, { Image, URL, window: { location: { origin: 'https://photos.test' } }, apiUrl: path => `https://photos.test${path}` });
  const canvas = (id, url) => ({ dataset: { photoId: id, imgUrl: url } });
  return { requests, load, canvas };
}
test('repeated faces share one download and decoded original even with different signed URLs', async () => {
  const { requests, load, canvas } = setup();
  const first = load(canvas('photo', '/original?token=one'));
  const second = load(canvas('photo', '/original?token=two'));
  assert.equal(requests.length, 1);
  assert.equal(first, second);
  requests[0].image.onload();
  assert.equal(await first, await second);
  assert.equal(await load(canvas('photo', '/original?token=three')), requests[0].image);
  assert.equal(requests.length, 1);
});
test('failed image downloads can retry with a renewed link', async () => {
  const { requests, load, canvas } = setup();
  const first = load(canvas('photo', '/expired'));
  requests[0].image.onerror();
  await assert.rejects(first, /Could not load/);
  const retry = load(canvas('photo', '/renewed'));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://photos.test/renewed');
  requests[1].image.onload();
  await retry;
});
test('offscreen pairs wait and intersecting pairs load only once', () => {
  let callback;
  const watched = new Set();
  const loaded = [];
  class IntersectionObserver {
    constructor(fn) { callback = fn; }
    observe(card) { watched.add(card); }
    unobserve(card) { watched.delete(card); }
  }
  const observerSource = source.slice(source.indexOf('let reviewObserver;'), source.indexOf('async function loadVerifyQueue()'));
  const observe = vm.runInNewContext(`${observerSource}\nobserveReviewImages`, {
    window: { IntersectionObserver }, IntersectionObserver,
    createReviewImageLoader: () => () => {},
    drawCroppedFaceCanvas: canvas => loaded.push(canvas),
  });
  const faces = [{}, {}];
  const card = { querySelectorAll: () => faces };
  observe({ querySelectorAll: () => [card] });
  assert.equal(loaded.length, 0);
  callback([{ target: card, isIntersecting: false }]);
  assert.equal(loaded.length, 0);
  callback([{ target: card, isIntersecting: true }]);
  assert.deepEqual(loaded, faces);
  assert.equal(watched.size, 0);
});
test('signed review photos use the same-origin proxy without changing their token', async () => {
  const { requests, load, canvas } = setup();
  const pending = load(canvas('photo', 'https://mambo-jambo-photo-api.surfersofindia.workers.dev/api/media/photo?variant=original&token=signed'));
  assert.equal(requests[0].url, 'https://photos.test/api/media/photo?variant=original&token=signed');
  requests[0].image.onload();
  await pending;
});
