#!/usr/bin/env node
/**
 * Matching-accuracy report for one consented session (W3-D).
 *
 * Takes the D1 export of a session (photos, faces with their stored embeddings, optional confirmed
 * burst/appearance links and appearance rows) plus crew labels (photo_id,surfer_id) and reports
 * precision / recall / F1 of the *shipped* `/api/match` pipeline at every MATCH_THRESHOLD from
 * 0.55 to 0.70, a per-surfer breakdown, the score distribution, how many photos have no face at
 * all (the burst/appearance fallback's job) and how often the HOG person detector produced an
 * appearance row. Plain Node, no dependencies; see docs/accuracy.md for the export commands.
 *
 *   node scripts/accuracy.mjs --photos photos.json --faces faces.json --labels labels.csv \
 *     [--links links.json] [--appearances appearances.json] [--threshold 0.62] \
 *     [--min 0.55 --max 0.70 --step 0.01] [--anchor clean|best] [--unlabelled exclude|negative] \
 *     [--min-confidence 0.6] [--json report.json] [--md report.md] [--title "…"]
 *   node scripts/accuracy.mjs --photos photos.json --template labels.csv   # a labels file to fill in
 *   node scripts/accuracy.mjs --selftest        # bundled fixture + agreement with worker.js
 *
 * Metric: every labelled surfer is a query. Each of their "clean" faces (a photo labelled with
 * exactly that one surfer and holding exactly one detected face) stands in for the selfie; the
 * query photo is removed from the gallery (leave-one-out) and the remaining photos are ranked
 * exactly as /api/match ranks them. Relevant = every other photo labelled with that surfer,
 * including photos with no face (only reachable through a confirmed link). Photos absent from
 * labels.csv are excluded from precision and recall by default (`--unlabelled negative` counts
 * them as wrong results instead).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

// ── Replicas of worker.js (kept in sync by --selftest, which runs the real /api/match handler on
//    the same fixture and requires identical output) ───────────────────────────────────────────
// worker.js similarity(): cosine over two equal-length arrays, -1 for anything else.
export function similarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}
export const DEFAULT_THRESHOLD = 0.62;          // worker.js: Number(env.MATCH_THRESHOLD || 0.62)
export const RESULT_CAP = 80;                   // worker.js: .slice(0, 80) before and after link extension
export const CONFIRMED_LINK_SCORE_DISCOUNT = 0.9;
/**
 * worker.js `/api/match` ranking (the `scores` Map → `matches` → confirmed-link `extensions` block):
 * per photo the best of its faces, `>= threshold`, sorted high to low, top 80; then every confirmed
 * link whose one side matched pulls in the other side at 0.9 × the anchor's score, re-sorted and
 * capped again. `faces` is [{ photo_id, embedding }] in the order D1 returns the rows (ties keep that
 * order, like the worker's Map); `links` is [{ photo1_id, photo2_id, status }] — only 'confirmed'
 * rows count, pending/rejected never reach a guest. Returns [[photoId, score, viaLink]].
 */
export function matchPhotos(query, faces, links, threshold = DEFAULT_THRESHOLD) {
  const scores = new Map();
  for (const face of faces) {
    const score = similarity(query, face.embedding);
    if (!Number.isFinite(score)) continue;
    scores.set(face.photo_id, Math.max(scores.get(face.photo_id) || -1, score));
  }
  let matches = [...scores.entries()].filter(([, score]) => score >= threshold).sort((a, b) => b[1] - a[1]).slice(0, RESULT_CAP)
    .map(([photoId, score]) => [photoId, score, false]);
  const matchedIds = new Set(matches.map(([photoId]) => photoId));
  if (matchedIds.size) {
    const extensions = [];
    for (const { photo1_id, photo2_id, status } of links) {
      if (status !== 'confirmed') continue;
      for (const [anchor, other] of [[photo1_id, photo2_id], [photo2_id, photo1_id]]) {
        if (!matchedIds.has(anchor) || matchedIds.has(other)) continue;
        matchedIds.add(other);
        extensions.push([other, (scores.get(anchor) ?? threshold) * CONFIRMED_LINK_SCORE_DISCOUNT, true]);
      }
    }
    if (extensions.length) matches = [...matches, ...extensions].sort((a, b) => b[1] - a[1]).slice(0, RESULT_CAP);
  }
  return matches;
}

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────
/** Rows from a JSON file: `wrangler d1 execute --json` output ([{ results, success }]), a bare
 *  array of rows, or { results }. Several statement results are concatenated. */
export function rowsFrom(data) {
  if (Array.isArray(data)) {
    if (data.length && data.every(item => item && typeof item === 'object' && Array.isArray(item.results))) return data.flatMap(item => item.results);
    return data;
  }
  if (data && Array.isArray(data.results)) return data.results;
  throw new Error('expected an array of rows, { results: [...] } or wrangler --json output');
}
// `a.json,b.json` concatenates paged exports (wrangler answers one LIMIT/OFFSET page per file).
const readRows = paths => paths.split(',').flatMap(path => rowsFrom(JSON.parse(readFileSync(path.trim(), 'utf8'))));
/** labels.csv → Map photo_id → Set of surfer ids. One row per surfer visible in a photo, `-` for "none
 *  of the labelled surfers" (the photo still counts as labelled); an empty surfer cell — what the
 *  `--template` output starts with — means "not labelled", so the photo is excluded. A header
 *  naming `photo_id` and `surfer_id` may put them in any column (the `--template` output adds a
 *  filename column between them); without one the first two columns are used. Cells are trimmed,
 *  quotes stripped, blank and `#` lines ignored. */
export function parseLabels(text) {
  const labels = new Map();
  let columns = [0, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));
    if (cells.some(cell => cell.toLowerCase() === 'photo_id')) {   // header
      const lower = cells.map(cell => cell.toLowerCase());
      columns = [lower.indexOf('photo_id'), lower.includes('surfer_id') ? lower.indexOf('surfer_id') : (lower.indexOf('photo_id') === 0 ? 1 : 0)];
      continue;
    }
    const photoId = cells[columns[0]] ?? ''; const surfer = cells[columns[1]] ?? '';
    if (!photoId || !surfer) continue;
    if (!labels.has(photoId)) labels.set(photoId, new Set());
    if (surfer !== '-') labels.get(photoId).add(surfer);
  }
  return labels;
}
/** A labels.csv to fill in: every completed photo once, filename beside the id, surfer_id empty. Add a
 *  row per extra surfer in a photo; put `-` for a photo with none of the labelled surfers. */
export function labelsTemplate(photos) {
  return ['photo_id,filename,surfer_id', ...photos.filter(photo => (photo.indexing_status || 'completed') === 'completed').map(photo => `${photo.id},${String(photo.filename ?? '').replace(/,/g, ' ')},`)].join('\n');
}
/** Normalise exported rows into the shape the evaluator wants; `embedding_json` (D1) or `embedding`
 *  (already parsed) are both accepted, malformed JSON is skipped the way the worker skips it. */
export function normaliseInputs({ photos, faces, links = [], appearances = [] }) {
  const parsedFaces = [];
  let malformed = 0;
  for (const face of faces) {
    let embedding = face.embedding;
    if (!Array.isArray(embedding)) { try { embedding = JSON.parse(face.embedding_json); } catch { malformed += 1; continue; } }
    if (!Array.isArray(embedding) || !embedding.length || !embedding.every(Number.isFinite)) { malformed += 1; continue; }
    parsedFaces.push({ id: face.id, photo_id: face.photo_id, embedding, confidence: Number(face.confidence) || null, bbox: parseBox(face.bbox_json ?? face.bbox_norm) });
  }
  return {
    photos: photos.map(photo => ({ id: photo.id, indexing_status: photo.indexing_status || 'completed', filename: photo.filename ?? null, captured_at: photo.captured_at ?? null })),
    faces: parsedFaces, malformed,
    links: links.map(link => ({ photo1_id: link.photo1_id, photo2_id: link.photo2_id, link_type: link.link_type || null, status: link.status || 'confirmed' })),
    appearances: new Map(appearances.map(row => [row.photo_id, parseBox(row.bbox_json ?? row.bbox_norm)])),
  };
}
/** [top%, left%, width%, height%] as stored in faces.bbox_json / photo_appearances.bbox_json, or null. */
function parseBox(value) {
  let box = value;
  if (typeof box === 'string') { try { box = JSON.parse(box); } catch { return null; } }
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) ? box : null;
}
/** Whether the centre of a face box sits inside a person box (both [top, left, w, h] in %). */
export function faceInsidePerson(face, person) {
  if (!face || !person) return false;
  const cx = face[1] + face[2] / 2; const cy = face[0] + face[3] / 2;
  return cx >= person[1] && cx <= person[1] + person[2] && cy >= person[0] && cy <= person[0] + person[3];
}

// ── Evaluation ──────────────────────────────────────────────────────────────────────────────────
const round = (value, places = 4) => (Number.isFinite(value) ? Number(value.toFixed(places)) : null);
const ratio = (num, den) => (den ? num / den : null);
const f1 = (p, r) => (p != null && r != null && p + r > 0 ? (2 * p * r) / (p + r) : (p == null || r == null ? null : 0));
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : null);
export function thresholdRange(min = 0.55, max = 0.70, step = 0.01) {
  const out = [];
  for (let i = 0; ; i += 1) { const t = round(min + i * step, 6); if (t > max + 1e-9) break; out.push(t); }
  return out;
}
/**
 * The report. `anchor`: 'clean' uses only faces from single-surfer, single-face photos as queries
 * (the face is certainly that surfer); 'best' also takes the most confident face of single-surfer
 * photos with several faces (noisier — a bystander could be the query). `unlabelled`: 'exclude'
 * ignores returned photos that are not in labels.csv, 'negative' counts them as false positives.
 */
export function evaluate(input, { thresholds = thresholdRange(), current = DEFAULT_THRESHOLD, anchor = 'clean', unlabelled = 'exclude', minConfidence = 0 } = {}) {
  const { photos, faces, links, appearances, labels } = input;
  const completed = photos.filter(photo => photo.indexing_status === 'completed');
  const completedIds = new Set(completed.map(photo => photo.id));
  // Only completed photos are searchable (the worker joins on indexing_status = 'completed'). The
  // worker stores and searches every face the service returns; `minConfidence` is a what-if that
  // drops low-confidence detections (back-of-head, distant, partial faces) from the gallery to show
  // what a confidence gate in the service or Worker would do to the curve. 0 = what ships.
  const gallery = faces.filter(face => completedIds.has(face.photo_id) && (!minConfidence || (face.confidence ?? 1) >= minConfidence));
  const droppedFaces = faces.filter(face => completedIds.has(face.photo_id)).length - gallery.length;
  const facesByPhoto = new Map();
  for (const face of gallery) { if (!facesByPhoto.has(face.photo_id)) facesByPhoto.set(face.photo_id, []); facesByPhoto.get(face.photo_id).push(face); }
  const confirmedLinks = links.filter(link => link.status === 'confirmed' && completedIds.has(link.photo1_id) && completedIds.has(link.photo2_id));

  // Labels restricted to searchable photos; surfers → their photos.
  const labelled = new Map([...labels].filter(([photoId]) => completedIds.has(photoId)));
  const surfers = new Map();
  for (const [photoId, ids] of labelled) for (const surfer of ids) { if (!surfers.has(surfer)) surfers.set(surfer, new Set()); surfers.get(surfer).add(photoId); }
  const zeroFace = completed.filter(photo => !facesByPhoto.has(photo.id));
  const zeroFaceLabelled = zeroFace.filter(photo => labelled.get(photo.id)?.size);
  // Label hygiene: a labelled photo with more detected faces than labelled surfers holds a bystander
  // or a missing label; fewer faces than labels means someone labelled was not detected (turned
  // away, too small) and is only reachable through a link.
  const moreFacesThanLabels = []; const fewerFacesThanLabels = [];
  for (const [photoId, ids] of labelled) {
    if (!ids.size) continue;
    const count = (facesByPhoto.get(photoId) || []).length;
    if (count > ids.size) moreFacesThanLabels.push({ photoId, faces: count, labels: [...ids] });
    else if (count < ids.size) fewerFacesThanLabels.push({ photoId, faces: count, labels: [...ids] });
  }

  // Queries: one per anchor face.
  const queries = [];
  for (const [surfer, photoIds] of surfers) {
    for (const photoId of photoIds) {
      if (labelled.get(photoId).size !== 1) continue;
      const own = facesByPhoto.get(photoId) || [];
      if (!own.length) continue;
      if (anchor === 'clean' && own.length !== 1) continue;
      const face = anchor === 'clean' ? own[0] : [...own].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
      queries.push({ surfer, photoId, faceId: face.id, embedding: face.embedding });
    }
  }
  // Per query, the per-photo max score over the leave-one-out gallery — computed once; thresholds
  // only filter. Positives/negatives feed the score distribution.
  const positives = []; const negatives = [];
  const prepared = queries.map(query => {
    const galleryFaces = gallery.filter(face => face.photo_id !== query.photoId);
    const relevant = new Set([...surfers.get(query.surfer)].filter(photoId => photoId !== query.photoId));
    const relevantWithFace = new Set([...relevant].filter(photoId => facesByPhoto.has(photoId)));
    const scores = new Map();
    for (const face of galleryFaces) { const score = similarity(query.embedding, face.embedding); if (Number.isFinite(score)) scores.set(face.photo_id, Math.max(scores.get(face.photo_id) || -1, score)); }
    for (const [photoId, score] of scores) {
      const ids = labelled.get(photoId); if (!ids) continue;
      (ids.has(query.surfer) ? positives : negatives).push(score);
    }
    return { ...query, galleryFaces, relevant, relevantWithFace, scores };
  });
  positives.sort((a, b) => a - b); negatives.sort((a, b) => a - b);
  // A query whose own photos all score below the current threshold while someone else's photo scores
  // ≥ 0.8 is most likely not the labelled surfer's face at all (a bystander in a single-face photo,
  // or a wrong label) — worth a human look before the numbers are trusted.
  const suspectQueries = prepared.flatMap(query => {
    let bestOwn = -1; let bestOther = -1; let otherPhoto = null;
    for (const [photoId, score] of query.scores) {
      const ids = labelled.get(photoId); if (!ids) continue;
      if (ids.has(query.surfer)) bestOwn = Math.max(bestOwn, score);
      else if (score > bestOther) { bestOther = score; otherPhoto = photoId; }
    }
    return query.relevant.size && bestOwn < current && bestOther >= 0.8 ? [{ surfer: query.surfer, photoId: query.photoId, bestOwn: round(bestOwn), bestOther: round(bestOther), otherPhoto }] : [];
  });

  const perSurfer = new Map([...surfers.keys()].map(surfer => [surfer, {
    surfer, photos: surfers.get(surfer).size, zeroFacePhotos: [...surfers.get(surfer)].filter(photoId => !facesByPhoto.has(photoId)).length,
    queries: prepared.filter(query => query.surfer === surfer).length, at: {},
  }]));
  const rows = thresholds.map(threshold => {
    const totals = { tp: 0, fp: 0, fn: 0, unlabelled: 0, viaLinkTp: 0, viaLinkFp: 0, zeroFaceRelevant: 0, zeroFaceReached: 0, fnWithFace: 0, tpWithFace: 0, empty: 0 };
    const precisions = []; const recalls = [];
    const bySurfer = new Map([...surfers.keys()].map(surfer => [surfer, { tp: 0, fp: 0, fn: 0 }]));
    for (const query of prepared) {
      const returned = matchPhotos(query.embedding, query.galleryFaces, confirmedLinks, threshold);
      let tp = 0; let fp = 0; let unknown = 0;
      for (const [photoId, , viaLink] of returned) {
        const ids = labelled.get(photoId);
        if (!ids) { if (unlabelled === 'negative') { fp += 1; if (viaLink) totals.viaLinkFp += 1; } else unknown += 1; continue; }
        if (query.relevant.has(photoId)) { tp += 1; if (viaLink) totals.viaLinkTp += 1; if (facesByPhoto.has(photoId)) totals.tpWithFace += 1; else totals.zeroFaceReached += 1; }
        else { fp += 1; if (viaLink) totals.viaLinkFp += 1; }
      }
      const fn = query.relevant.size - tp;
      totals.fnWithFace += query.relevantWithFace.size - [...query.relevantWithFace].filter(photoId => returned.some(([id]) => id === photoId)).length;
      totals.zeroFaceRelevant += query.relevant.size - query.relevantWithFace.size;
      totals.tp += tp; totals.fp += fp; totals.fn += fn; totals.unlabelled += unknown;
      if (!returned.length) totals.empty += 1;
      if (tp + fp) precisions.push(tp / (tp + fp));
      if (query.relevant.size) recalls.push(tp / query.relevant.size);
      const s = bySurfer.get(query.surfer); s.tp += tp; s.fp += fp; s.fn += fn;
    }
    const precision = ratio(totals.tp, totals.tp + totals.fp); const recall = ratio(totals.tp, totals.tp + totals.fn);
    const recallFaceOnly = ratio(totals.tpWithFace, totals.tpWithFace + totals.fnWithFace);
    for (const [surfer, s] of bySurfer) {
      const p = ratio(s.tp, s.tp + s.fp); const r = ratio(s.tp, s.tp + s.fn);
      perSurfer.get(surfer).at[threshold.toFixed(2)] = { tp: s.tp, fp: s.fp, fn: s.fn, precision: round(p), recall: round(r), f1: round(f1(p, r)) };
    }
    return {
      threshold, queries: prepared.length, tp: totals.tp, fp: totals.fp, fn: totals.fn, unlabelledReturned: totals.unlabelled,
      precision: round(precision), recall: round(recall), f1: round(f1(precision, recall)),
      recallFaceOnly: round(recallFaceOnly),
      meanQueryPrecision: round(precisions.length ? precisions.reduce((a, b) => a + b, 0) / precisions.length : null),
      meanQueryRecall: round(recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null),
      emptyQueries: totals.empty, viaLinkTp: totals.viaLinkTp, viaLinkFp: totals.viaLinkFp,
      zeroFaceRelevant: totals.zeroFaceRelevant, zeroFaceReached: totals.zeroFaceReached,
    };
  });

  // HOG person detector: how often an appearance row exists, split by whether a face was found.
  const withFace = completed.filter(photo => facesByPhoto.has(photo.id));
  // Stronger than "a row exists": when both boxes were exported, does the person box contain one of
  // the detected faces? A box that holds no face is a bystander, a board, or noise — its clothing
  // histogram then describes someone else and any appearance link built on it is wrong.
  const boxed = withFace.filter(photo => appearances.get(photo.id) && facesByPhoto.get(photo.id).some(face => face.bbox));
  const hog = {
    photosWithFace: withFace.length, withFaceAndAppearance: withFace.filter(photo => appearances.has(photo.id)).length,
    zeroFacePhotos: zeroFace.length, zeroFaceWithAppearance: zeroFace.filter(photo => appearances.has(photo.id)).length,
    photosWithAppearance: completed.filter(photo => appearances.has(photo.id)).length,
    boxesChecked: boxed.length, boxContainsAFace: boxed.filter(photo => facesByPhoto.get(photo.id).some(face => faceInsidePerson(face.bbox, appearances.get(photo.id)))).length,
  };
  hog.recallGivenFace = round(ratio(hog.withFaceAndAppearance, hog.photosWithFace));
  hog.boxContainsAFaceRate = round(ratio(hog.boxContainsAFace, hog.boxesChecked));
  hog.recallOfTheRightPerson = round(hog.boxesChecked ? (hog.boxContainsAFace / hog.boxesChecked) * (hog.withFaceAndAppearance / hog.photosWithFace) : null);
  hog.rateGivenNoFace = round(ratio(hog.zeroFaceWithAppearance, hog.zeroFacePhotos));
  hog.rateOverall = round(ratio(hog.photosWithAppearance, completed.length));
  // Both ends of an appearance link need a row, so this is the share of (faceless, with-face) pairs
  // the signal can even score.
  hog.linkablePairShare = round(hog.recallGivenFace != null && hog.rateGivenNoFace != null ? hog.recallGivenFace * hog.rateGivenNoFace : null);

  const currentRow = rows.find(row => Math.abs(row.threshold - current) < 1e-9) || null;
  return {
    generatedAt: new Date().toISOString(),
    settings: { current, anchor, unlabelled, minConfidence, thresholds: [thresholds[0], thresholds[thresholds.length - 1]], step: thresholds.length > 1 ? round(thresholds[1] - thresholds[0], 6) : null },
    session: {
      photos: photos.length, completed: completed.length, pending: photos.filter(photo => photo.indexing_status === 'pending').length, failed: photos.filter(photo => photo.indexing_status === 'failed').length,
      faces: gallery.length, malformedFaces: input.malformed || 0, droppedFaces, photosWithFace: withFace.length, zeroFacePhotos: zeroFace.length, zeroFaceLabelled: zeroFaceLabelled.length,
      labelledPhotos: labelled.size, unlabelledPhotos: completed.length - labelled.size, nonePhotos: [...labelled.values()].filter(ids => !ids.size).length,
      surfers: surfers.size, surfersWithoutQuery: [...surfers.keys()].filter(surfer => !prepared.some(query => query.surfer === surfer)).length,
      queries: prepared.length, confirmedLinks: confirmedLinks.length, linksIgnored: links.length - confirmedLinks.length,
    },
    scores: {
      positives: { count: positives.length, min: round(positives[0]), p10: round(quantile(positives, 0.1)), median: round(quantile(positives, 0.5)), max: round(positives[positives.length - 1]) },
      negatives: { count: negatives.length, median: round(quantile(negatives, 0.5)), p90: round(quantile(negatives, 0.9)), p99: round(quantile(negatives, 0.99)), max: round(negatives[negatives.length - 1]) },
    },
    hog, thresholds: rows, perSurfer: [...perSurfer.values()],
    diagnostics: { moreFacesThanLabels, fewerFacesThanLabels, suspectQueries, faceConfidence: confidenceSummary(gallery) },
    recommendation: recommend(rows, currentRow, current, prepared.length),
  };
}
function confidenceSummary(faces) {
  const values = faces.map(face => face.confidence).filter(Number.isFinite).sort((a, b) => a - b);
  return { known: values.length, min: round(values[0]), p10: round(quantile(values, 0.1)), median: round(quantile(values, 0.5)), below60: values.filter(value => value < 0.6).length, below70: values.filter(value => value < 0.7).length };
}
/** Only ever moves off the current threshold on clear evidence: at least 20 queries, a candidate
 *  in the sweep whose F1 beats the current one by 0.02 with precision ≥ 0.90. Otherwise "keep". */
export const MIN_QUERIES_FOR_A_CHANGE = 20;
export function recommend(rows, currentRow, current, queries) {
  const usable = rows.filter(row => row.f1 != null);
  const bestF1 = usable.length ? usable.reduce((best, row) => (row.f1 > best.f1 ? row : best)) : null;
  const precise = usable.filter(row => row.precision >= 0.9);
  const bestPrecise = precise.length ? precise.reduce((best, row) => (row.f1 > best.f1 || (row.f1 === best.f1 && row.recall > best.recall) ? row : best)) : null;
  let verdict; let threshold = current;
  if (!currentRow || !usable.length) verdict = `no measurable queries — keep MATCH_THRESHOLD at ${current}`;
  else if (queries < MIN_QUERIES_FOR_A_CHANGE) verdict = `only ${queries} queries (need ${MIN_QUERIES_FOR_A_CHANGE}) — keep MATCH_THRESHOLD at ${current}`;
  else if (bestPrecise && bestPrecise.threshold !== current && bestPrecise.f1 - (currentRow.f1 ?? 0) >= 0.02) { threshold = bestPrecise.threshold; verdict = `move MATCH_THRESHOLD to ${threshold} (F1 ${bestPrecise.f1} vs ${currentRow.f1} at ${current}, precision ${bestPrecise.precision})`; }
  else verdict = `keep MATCH_THRESHOLD at ${current} (precision ${currentRow.precision}, recall ${currentRow.recall}, F1 ${currentRow.f1})`;
  return { threshold, verdict, current: currentRow && { precision: currentRow.precision, recall: currentRow.recall, f1: currentRow.f1 }, bestF1: bestF1 && { threshold: bestF1.threshold, f1: bestF1.f1 }, bestWithPrecision90: bestPrecise && { threshold: bestPrecise.threshold, f1: bestPrecise.f1, recall: bestPrecise.recall } };
}

// ── Markdown ────────────────────────────────────────────────────────────────────────────────────
const pct = value => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const num = value => (value == null ? '—' : String(value));
export function markdown(report, title = 'Matching accuracy') {
  const { session, hog, scores, recommendation } = report;
  const lines = [`# ${title}`, '', `Generated ${report.generatedAt} · anchor faces: ${report.settings.anchor} · unlabelled photos: ${report.settings.unlabelled} · current MATCH_THRESHOLD ${report.settings.current}`, ''];
  lines.push('## Session', '', '| Photos | Completed | Pending / failed | Faces | Photos with a face | Zero-face photos (labelled) | Labelled / unlabelled photos | Surfers | Queries | Confirmed links |', '|---|---|---|---|---|---|---|---|---|---|',
    `| ${session.photos} | ${session.completed} | ${session.pending} / ${session.failed} | ${session.faces}${session.malformedFaces ? ` (+${session.malformedFaces} malformed skipped)` : ''} | ${session.photosWithFace} | ${session.zeroFacePhotos} (${session.zeroFaceLabelled}) | ${session.labelledPhotos} / ${session.unlabelledPhotos} | ${session.surfers}${session.surfersWithoutQuery ? ` (${session.surfersWithoutQuery} without a clean query face)` : ''} | ${session.queries} | ${session.confirmedLinks}${session.linksIgnored ? ` (${session.linksIgnored} pending/rejected ignored)` : ''} |`, '');
  lines.push('## Precision and recall by threshold', '', 'Micro-averaged over every query (leave-one-out). `recall (face)` counts only relevant photos that have a detected face; `via link` are results that arrived through a confirmed burst/appearance link; `zero-face reached` is how many relevant faceless photos a link pulled in; `empty` is the number of queries that returned nothing.', '',
    '| Threshold | Precision | Recall | F1 | Recall (face) | Mean query precision | TP | FP | FN | Via link (TP/FP) | Zero-face reached | Empty |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of report.thresholds) {
    const mark = Math.abs(row.threshold - report.settings.current) < 1e-9 ? ' **(current)**' : '';
    lines.push(`| ${row.threshold.toFixed(2)}${mark} | ${pct(row.precision)} | ${pct(row.recall)} | ${pct(row.f1)} | ${pct(row.recallFaceOnly)} | ${pct(row.meanQueryPrecision)} | ${row.tp} | ${row.fp} | ${row.fn} | ${row.viaLinkTp}/${row.viaLinkFp} | ${row.zeroFaceReached}/${row.zeroFaceRelevant} | ${row.emptyQueries} |`);
  }
  lines.push('', `**Recommendation:** ${recommendation.verdict}.`, '');
  lines.push('## Score distribution', '', `Per-photo best similarity from every query to every labelled photo: **same surfer** n=${scores.positives.count}, min ${num(scores.positives.min)}, p10 ${num(scores.positives.p10)}, median ${num(scores.positives.median)}, max ${num(scores.positives.max)} · **other people** n=${scores.negatives.count}, median ${num(scores.negatives.median)}, p90 ${num(scores.negatives.p90)}, p99 ${num(scores.negatives.p99)}, max ${num(scores.negatives.max)}.`, '');
  lines.push('## Per surfer', '', `At the current threshold ${report.settings.current}.`, '', '| Surfer | Photos | Zero-face photos | Queries | Precision | Recall | F1 | TP | FP | FN |', '|---|---|---|---|---|---|---|---|---|---|');
  const key = report.settings.current.toFixed(2);
  for (const surfer of report.perSurfer) {
    const at = surfer.at[key] || {};
    lines.push(`| ${surfer.surfer} | ${surfer.photos} | ${surfer.zeroFacePhotos} | ${surfer.queries} | ${pct(at.precision)} | ${pct(at.recall)} | ${pct(at.f1)} | ${num(at.tp)} | ${num(at.fp)} | ${num(at.fn)} |`);
  }
  const d = report.diagnostics;
  lines.push('', '## Label and detection checks', '', `Face confidence (${d.faceConfidence.known} faces): min ${num(d.faceConfidence.min)}, p10 ${num(d.faceConfidence.p10)}, median ${num(d.faceConfidence.median)}, ${d.faceConfidence.below60} below 0.60, ${d.faceConfidence.below70} below 0.70${report.settings.minConfidence ? ` — faces below ${report.settings.minConfidence} were dropped from the gallery for this run (${session.droppedFaces})` : ''}.`, '',
    `- Photos with more detected faces than labelled surfers (bystander or missing label): **${d.moreFacesThanLabels.length}**${d.moreFacesThanLabels.length ? ` — ${d.moreFacesThanLabels.slice(0, 12).map(item => `${item.photoId} (${item.faces} faces, ${item.labels.join('+')})`).join(', ')}${d.moreFacesThanLabels.length > 12 ? ', …' : ''}` : ''}`,
    `- Labelled surfers with no detected face in the photo (only reachable through a link): **${d.fewerFacesThanLabels.length}** photos${d.fewerFacesThanLabels.length ? ` — ${d.fewerFacesThanLabels.slice(0, 12).map(item => `${item.photoId} (${item.faces} faces, ${item.labels.join('+')})`).join(', ')}${d.fewerFacesThanLabels.length > 12 ? ', …' : ''}` : ''}`,
    `- Suspect queries (own photos all below ${report.settings.current}, someone else's photo ≥ 0.80 — probably not that surfer's face): **${d.suspectQueries.length}**${d.suspectQueries.length ? ` — ${d.suspectQueries.slice(0, 12).map(item => `${item.surfer}/${item.photoId} → ${item.otherPhoto} ${item.bestOther}`).join(', ')}${d.suspectQueries.length > 12 ? ', …' : ''}` : ''}`);
  lines.push('', '## HOG person detector (appearance signal)', '', '| Photos with a face | …with an appearance row | Recall given a face | Person box contains a detected face | Recall of the right person | Zero-face photos | …with an appearance row | Rate given no face | Overall | Linkable pair share |', '|---|---|---|---|---|---|---|---|---|---|',
    `| ${hog.photosWithFace} | ${hog.withFaceAndAppearance} | ${pct(hog.recallGivenFace)} | ${hog.boxesChecked ? `${hog.boxContainsAFace}/${hog.boxesChecked} (${pct(hog.boxContainsAFaceRate)})` : 'no boxes exported'} | ${pct(hog.recallOfTheRightPerson)} | ${hog.zeroFacePhotos} | ${hog.zeroFaceWithAppearance} | ${pct(hog.rateGivenNoFace)} | ${pct(hog.rateOverall)} | ${pct(hog.linkablePairShare)} |`, '',
    '`Recall given a face` is how often HOG produced any person box on a photo with a detected face; `person box contains a detected face` checks the box against the face boxes when both were exported (`bbox_json`), and `recall of the right person` is the product — the share of face photos whose clothing histogram belongs to a detected person. Zero-face photos cannot be checked this way: a row there may be the surfer or a bystander.', '');
  return lines.join('\n');
}

// ── Self-test: bundled fixture + agreement with the real worker.js handler ───────────────────────
/** 10-d unit vectors with chosen cosines that sit strictly between the 0.01 grid points, so every
 *  threshold transition in the sweep is known and no `>=` comparison lands on a float boundary.
 *  e(i) is the i-th basis vector; mix(i, c, j) has cosine c with e(i) and √(1−c²) with e(j). */
const e = i => Array.from({ length: 10 }, (_, k) => (k === i ? 1 : 0));
const mix = (i, c, j) => e(i).map((v, k) => v * c + (k === j ? Math.sqrt(1 - c * c) : 0));
export function fixture() {
  // Surfers A (e0), B (e1), C (e2). Photo ids say what they hold.
  const photos = [
    { id: 'a-1', indexing_status: 'completed' }, { id: 'a-2', indexing_status: 'completed' }, { id: 'a-3', indexing_status: 'completed' },
    { id: 'b-1', indexing_status: 'completed' }, { id: 'b-2', indexing_status: 'completed' }, { id: 'b-hard', indexing_status: 'completed' },
    { id: 'c-1', indexing_status: 'completed' }, { id: 'c-2', indexing_status: 'completed' },
    { id: 'ab-group', indexing_status: 'completed' }, { id: 'a-noface', indexing_status: 'completed' }, { id: 'c-noface', indexing_status: 'completed' },
    { id: 'none', indexing_status: 'completed' }, { id: 'unlabelled', indexing_status: 'completed' }, { id: 'a-pending', indexing_status: 'pending' },
  ];
  const faces = [
    { id: 'f-a1', photo_id: 'a-1', embedding: e(0), confidence: 0.9 },
    { id: 'f-a2', photo_id: 'a-2', embedding: mix(0, 0.95, 3), confidence: 0.9 },    // cos 0.95 with A
    { id: 'f-a3', photo_id: 'a-3', embedding: mix(0, 0.605, 4), confidence: 0.9 },   // cos 0.605 with A → in only at ≤ 0.60
    { id: 'f-b1', photo_id: 'b-1', embedding: e(1), confidence: 0.9 },
    { id: 'f-b2', photo_id: 'b-2', embedding: mix(1, 0.80, 5), confidence: 0.9 },
    { id: 'f-bh', photo_id: 'b-hard', embedding: mix(0, 0.645, 1), confidence: 0.9 }, // B's face, but cos 0.645 with A (0.764 with B)
    { id: 'f-c1', photo_id: 'c-1', embedding: e(2), confidence: 0.9 },
    { id: 'f-c2', photo_id: 'c-2', embedding: mix(2, 0.705, 6), confidence: 0.9 },   // survives the whole sweep (≤ 0.70)
    { id: 'f-g1', photo_id: 'ab-group', embedding: mix(0, 0.90, 7), confidence: 0.8 },
    { id: 'f-g2', photo_id: 'ab-group', embedding: mix(1, 0.90, 7), confidence: 0.7 },
    { id: 'f-n1', photo_id: 'none', embedding: e(8), confidence: 0.9 },
    { id: 'f-u1', photo_id: 'unlabelled', embedding: mix(0, 0.99, 6), confidence: 0.9 },
    { id: 'f-p1', photo_id: 'a-pending', embedding: e(0), confidence: 0.9 },
    { id: 'f-bad', photo_id: 'a-1', embedding_json: '{not json', confidence: 0.9 },
  ];
  const links = [
    { photo1_id: 'a-1', photo2_id: 'a-noface', link_type: 'burst', status: 'confirmed' },
    { photo1_id: 'c-noface', photo2_id: 'c-1', link_type: 'appearance', status: 'pending' },
    { photo1_id: 'c-noface', photo2_id: 'c-2', link_type: 'appearance', status: 'rejected' },
  ];
  // a-1's person box holds its face; a-2's box is a bystander (the face sits outside it); none has no box.
  faces[0].bbox_json = '[10,40,20,30]'; faces[1].bbox_json = '[5,5,20,30]';
  const appearances = [{ photo_id: 'a-1', bbox_json: '[0,30,40,100]' }, { photo_id: 'a-2', bbox_json: '[0,60,40,100]' }, { photo_id: 'a-noface', bbox_json: '[0,0,50,100]' }, { photo_id: 'none' }];
  const labels = ['photo_id,surfer_id', 'a-1,A', 'a-2,A', 'a-3,A', 'b-1,B', 'b-2,B', 'b-hard,B', 'c-1,C', 'c-2,C', 'ab-group,A', 'ab-group,B', 'a-noface,A', 'c-noface,C', 'none,-', 'a-pending,A'].join('\n');
  return { photos, faces, links, appearances, labels };
}
async function selftest() {
  const assert = (await import('node:assert/strict')).default;
  const raw = fixture();
  const input = { ...normaliseInputs(raw), labels: parseLabels(raw.labels) };
  assert.equal(input.malformed, 1, 'the malformed embedding_json row is skipped');
  const report = evaluate(input, { thresholds: thresholdRange(0.55, 0.70, 0.01), current: 0.62 });
  // Queries: clean anchors only — a-1, a-2, a-3 (A), b-1, b-2, b-hard (B), c-1, c-2 (C); ab-group has two
  // faces and two labels, a-pending is not searchable.
  assert.equal(report.session.queries, 8); assert.equal(report.session.completed, 13); assert.equal(report.session.faces, 12);
  assert.equal(report.session.zeroFacePhotos, 2); assert.equal(report.session.zeroFaceLabelled, 2); assert.equal(report.session.confirmedLinks, 1); assert.equal(report.session.linksIgnored, 2);
  assert.equal(report.session.unlabelledPhotos, 1); assert.equal(report.session.nonePhotos, 1);
  const at = t => report.thresholds.find(row => Math.abs(row.threshold - t) < 1e-9);
  // Hand-derived at 0.62 (per query, only labelled photos count; `u` = the unlabelled photo, cos 0.99 with A):
  //  A/a-1: a-2 .95, ab-group .90, b-hard .645 (FP), a-3 .605 ✗, u .99            → tp 2 fp 1 fn 2 (a-3, a-noface: its link is to the query photo)
  //  A/a-2: a-1 .95 → link a-noface .855 (TP), ab-group .855, b-hard .613 ✗, u    → tp 3 fp 0 fn 1
  //  A/a-3: nothing ≥ .62 (a-1 .605)                                                → tp 0 fp 0 fn 4, empty
  //  B/b-1: ab-group .90, b-2 .80, b-hard .764                                      → tp 3 fp 0 fn 0
  //  B/b-2: b-1 .80, ab-group .72, b-hard .611 ✗                                    → tp 2 fp 0 fn 1
  //  B/b-hard: b-1 .764, ab-group .688 (via f-g2), a-1 .645 (FP) → link a-noface .58 (FP), u .639 → tp 2 fp 2 fn 1
  //  C/c-1: c-2 .705; c-noface's links are pending/rejected                        → tp 1 fp 0 fn 1
  //  C/c-2: c-1 .705                                                                → tp 1 fp 0 fn 1
  const row62 = at(0.62);
  assert.deepEqual([row62.tp, row62.fp, row62.fn, row62.emptyQueries, row62.viaLinkTp, row62.viaLinkFp, row62.zeroFaceReached, row62.zeroFaceRelevant], [14, 3, 11, 1, 1, 1, 1, 5]);
  assert.equal(row62.precision, round(14 / 17)); assert.equal(row62.recall, round(14 / 25));
  assert.equal(row62.recallFaceOnly, round(13 / 20));
  // The unlabelled photo is returned for a-1, a-2 and b-hard but never counted…
  assert.equal(row62.unlabelledReturned, 3);
  // …unless asked to; then each is a false positive.
  const strict = evaluate(input, { thresholds: [0.62], current: 0.62, unlabelled: 'negative' }).thresholds[0];
  assert.deepEqual([strict.tp, strict.fp, strict.unlabelledReturned], [14, 6, 0]);
  // Transitions: b-2 ↔ b-hard (.611) and a-2 ↔ b-hard (.613) at ≤ .61; a-1 ↔ a-3 (.605, plus a-3 → a-1 → link
  // a-noface) at ≤ .60; a-2 ↔ a-3 (.575) at ≤ .57; b-hard ↔ a-1 (.645, plus its link) gone from .65; b-hard →
  // ab-group (.688) gone from .69; c-1 ↔ c-2 (.705) survive the whole sweep.
  assert.deepEqual([at(0.61).tp, at(0.61).fp], [16, 5]);
  assert.deepEqual([at(0.60).tp, at(0.60).fp, at(0.60).emptyQueries], [19, 5, 0]);
  assert.deepEqual([at(0.55).tp, at(0.55).fp, at(0.55).recall], [21, 5, round(21 / 25)]);
  assert.deepEqual([at(0.64).tp, at(0.64).fp], [14, 3]); assert.deepEqual([at(0.65).tp, at(0.65).fp], [14, 0]);
  assert.deepEqual([at(0.68).tp, at(0.69).tp, at(0.70).tp, at(0.70).fp], [14, 13, 13, 0]);
  assert.ok(report.thresholds.every(row => row.tp + row.fn === 25), 'tp + fn is the number of relevant photos at every threshold');
  // Per-surfer and HOG bookkeeping.
  const perA = report.perSurfer.find(surfer => surfer.surfer === 'A');
  assert.deepEqual([perA.photos, perA.zeroFacePhotos, perA.queries], [5, 1, 3]);
  assert.deepEqual(perA.at['0.62'], { tp: 5, fp: 1, fn: 7, precision: round(5 / 6), recall: round(5 / 12), f1: round(f1(5 / 6, 5 / 12)) });
  assert.deepEqual([report.hog.photosWithFace, report.hog.withFaceAndAppearance, report.hog.zeroFacePhotos, report.hog.zeroFaceWithAppearance], [11, 3, 2, 1]);
  assert.equal(report.hog.recallGivenFace, round(3 / 11)); assert.equal(report.hog.rateGivenNoFace, 0.5);
  assert.deepEqual([report.hog.boxesChecked, report.hog.boxContainsAFace, report.hog.boxContainsAFaceRate, report.hog.recallOfTheRightPerson], [2, 1, 0.5, round(0.5 * (3 / 11))]);
  assert.equal(faceInsidePerson([10, 40, 20, 30], [0, 30, 40, 100]), true); assert.equal(faceInsidePerson([5, 5, 20, 30], [0, 60, 40, 100]), false); assert.equal(faceInsidePerson(null, [0, 0, 1, 1]), false);
  // Diagnostics: ab-group has 2 faces and 2 labels (fine); a-noface/c-noface are labelled but faceless;
  // no query is suspect. Dropping faces under 0.75 removes ab-group's 0.7 face, so B loses that photo.
  assert.deepEqual(report.diagnostics.moreFacesThanLabels, []);
  assert.deepEqual(report.diagnostics.fewerFacesThanLabels.map(item => item.photoId), ['a-noface', 'c-noface']);
  assert.deepEqual(report.diagnostics.suspectQueries, []);
  assert.deepEqual([report.diagnostics.faceConfidence.known, report.diagnostics.faceConfidence.below70], [12, 0]);
  const gated = evaluate(input, { thresholds: [0.62], current: 0.62, minConfidence: 0.75 });
  assert.equal(gated.session.droppedFaces, 1); assert.equal(gated.session.faces, 11);
  assert.equal(gated.thresholds[0].tp, 11);   // b-1, b-2 and b-hard no longer reach ab-group through f-g2
  // A mislabelled single-face photo shows up as a suspect query: call b-1's face "D", whose only other
  // photo (d-2) looks nothing like it, while ab-group (B's face, 0.9) is right there.
  const mislabelled = { ...input, photos: [...input.photos, { id: 'd-2', indexing_status: 'completed' }], faces: [...input.faces, { id: 'f-d2', photo_id: 'd-2', embedding: e(9), confidence: 0.9 }],
    labels: new Map([...input.labels, ['b-1', new Set(['D'])], ['d-2', new Set(['D'])]]) };
  assert.deepEqual(evaluate(mislabelled, { thresholds: [0.62] }).diagnostics.suspectQueries.map(item => [item.surfer, item.photoId, item.otherPhoto]), [['D', 'b-1', 'ab-group']]);
  // Too few queries to ever recommend a move.
  assert.equal(report.recommendation.threshold, 0.62); assert.match(report.recommendation.verdict, /only 8 queries/);
  // A second face in a single-surfer photo disqualifies it as a clean anchor; `best` takes the confident one.
  const twoFaces = { ...input, faces: [...input.faces, { id: 'f-a1b', photo_id: 'a-1', embedding: e(9), confidence: 0.3 }] };
  assert.equal(evaluate(twoFaces, { thresholds: [0.62] }).session.queries, 7);
  assert.equal(evaluate(twoFaces, { thresholds: [0.62], anchor: 'best' }).session.queries, 8);
  // wrangler --json shapes and the label parser.
  assert.deepEqual(rowsFrom([{ results: [{ id: 1 }], success: true }, { results: [{ id: 2 }], success: true }]), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(rowsFrom({ results: [{ id: 3 }] }), [{ id: 3 }]); assert.deepEqual(rowsFrom([{ id: 4 }]), [{ id: 4 }]);
  assert.deepEqual([...parseLabels('photo_id,surfer_id\n p1 , s1 \n"p1","s2"\np2,-\np3,\n# comment\n')].map(([k, v]) => [k, [...v]]), [['p1', ['s1', 's2']], ['p2', []]]);   // p3 left blank → unlabelled
  assert.deepEqual([...parseLabels('surfer_id,photo_id\ns1,p1')].map(([k, v]) => [k, [...v]]), [['p1', ['s1']]]);
  const template = labelsTemplate([{ id: 'p1', filename: 'IMG_1.jpg' }, { id: 'p2', filename: 'a,b.jpg', indexing_status: 'pending' }, { id: 'p3', filename: 'IMG_3.jpg', indexing_status: 'completed' }]);
  assert.equal(template, 'photo_id,filename,surfer_id\np1,IMG_1.jpg,\np3,IMG_3.jpg,');
  assert.deepEqual([...parseLabels(`${template}\np1,IMG_1.jpg,s9\np3,IMG_3.jpg,-`)].map(([k, v]) => [k, [...v]]), [['p1', ['s9']], ['p3', []]]);   // the blank template rows are ignored
  assert.ok(markdown(report).includes('| 0.62 **(current)** |'));
  await agreesWithWorker(input);
  console.log(`selftest ok: ${report.session.queries} queries, ${report.thresholds.length} thresholds, worker.js /api/match agrees on the fixture`);
}
/** Runs the real /api/match handler from worker.js (imported from source, mocked env, like
 *  tests/worker.test.mjs) for every fixture face at four thresholds and requires the same photo
 *  ids in the same order with the same rounded scores as matchPhotos(). */
async function agreesWithWorker(input) {
  const assert = (await import('node:assert/strict')).default;
  const source = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const completed = new Set(input.photos.filter(photo => photo.indexing_status === 'completed').map(photo => photo.id));
  const galleryFaces = input.faces.filter(face => completed.has(face.photo_id));
  const links = input.links.filter(link => link.status === 'confirmed');
  const makeEnv = (threshold, excludePhoto) => ({
    SESSION_SECRET: 'selftest-signing-key', FACE_API_URL: 'https://face.example/extract', MATCH_THRESHOLD: String(threshold),
    DB: { prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; },
      async first() {
        if (sql.includes('FROM sessions WHERE id')) return { id: 'session-1', title: 'Fixture', session_date: '2026-09-17', location: 'Mulki', price_paise: 100, currency: 'INR' };
        if (sql.includes('COUNT(*) as total')) return { total: completed.size, completed: completed.size, pending: 0 };
        if (sql.includes('INSERT INTO rate_limits')) return { count: 1, elapsed: 0 };
        throw new Error(`unexpected first(): ${sql}`);
      },
      async all() {
        if (sql.startsWith('PRAGMA')) return { results: [{ name: 'id' }] };
        if (sql.includes('FROM faces f JOIN photos p')) return { results: galleryFaces.filter(face => face.photo_id !== excludePhoto).map(face => ({ photo_id: face.photo_id, embedding_json: JSON.stringify(face.embedding) })) };
        if (sql.includes('FROM photo_links')) { const ids = new Set(this.values.slice(1)); return { results: links.filter(link => ids.has(link.photo1_id) || ids.has(link.photo2_id)).map(({ photo1_id, photo2_id }) => ({ photo1_id, photo2_id })) }; }
        throw new Error(`unexpected all(): ${sql}`);
      },
      async run() { return {}; },
    }; }, async batch(statements) { return Promise.all(statements.map(statement => statement.run())); } },
  });
  // One threshold is an exact score from the fixture (a-1 ↔ a-3), so `>=` versus `>` shows up too:
  // MATCH_THRESHOLD round-trips through String() without loss.
  const boundary = similarity(input.faces.find(face => face.id === 'f-a1').embedding, input.faces.find(face => face.id === 'f-a3').embedding);
  const realFetch = globalThis.fetch;
  try {
    for (const threshold of [0.55, 0.62, 0.70, boundary]) {
      for (const query of input.faces.filter(face => completed.has(face.photo_id))) {
        globalThis.fetch = async () => Response.json({ faces: [{ embedding: query.embedding }] });
        const form = new FormData(); form.append('sessionId', 'session-1'); form.append('consent', 'true'); form.append('file', new Blob(['x'], { type: 'image/jpeg' }), 'selfie.jpg');
        const response = await worker.fetch(new Request('https://api.example/api/match', { method: 'POST', body: form }), makeEnv(threshold, query.photo_id), {});
        assert.equal(response.status, 200, `worker /api/match ${query.id} @ ${threshold}`);
        const { previews } = await response.json();
        const expected = matchPhotos(query.embedding, galleryFaces.filter(face => face.photo_id !== query.photo_id), links, threshold).map(([photoId, score]) => [photoId, Math.round(score * 100)]);
        assert.deepEqual(previews.map(preview => [preview.photoId, preview.score]), expected, `ranking for ${query.id} @ ${threshold}`);
      }
    }
  } finally { globalThis.fetch = realFetch; }
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const { values } = parseArgs({ options: {
    photos: { type: 'string' }, faces: { type: 'string' }, labels: { type: 'string' }, links: { type: 'string' }, appearances: { type: 'string' },
    threshold: { type: 'string', default: String(DEFAULT_THRESHOLD) }, min: { type: 'string', default: '0.55' }, max: { type: 'string', default: '0.70' }, step: { type: 'string', default: '0.01' },
    anchor: { type: 'string', default: 'clean' }, unlabelled: { type: 'string', default: 'exclude' }, 'min-confidence': { type: 'string', default: '0' }, json: { type: 'string' }, md: { type: 'string' }, title: { type: 'string', default: 'Matching accuracy' },
    template: { type: 'string' }, selftest: { type: 'boolean', default: false }, quiet: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*\n|^ \* ?/gm, '')); return; }
  if (values.selftest) { await selftest(); return; }
  if (values.template) {
    if (!values.photos) { console.error('--template needs --photos photos.json'); process.exitCode = 2; return; }
    writeFileSync(values.template, `${labelsTemplate(readRows(values.photos))}\n`); console.log(`wrote ${values.template} — fill in surfer_id (one row per surfer in a photo, '-' for none)`); return;
  }
  if (!values.photos || !values.faces || !values.labels) { console.error('usage: node scripts/accuracy.mjs --photos photos.json --faces faces.json --labels labels.csv [--links links.json] [--appearances appearances.json] …  (or --selftest, --help)'); process.exitCode = 2; return; }
  if (!['clean', 'best'].includes(values.anchor) || !['exclude', 'negative'].includes(values.unlabelled)) { console.error('--anchor is clean|best, --unlabelled is exclude|negative'); process.exitCode = 2; return; }
  const raw = { photos: readRows(values.photos), faces: readRows(values.faces), links: values.links ? readRows(values.links) : [], appearances: values.appearances ? readRows(values.appearances) : [] };
  const input = { ...normaliseInputs(raw), labels: parseLabels(readFileSync(values.labels, 'utf8')) };
  const report = evaluate(input, { thresholds: thresholdRange(Number(values.min), Number(values.max), Number(values.step)), current: Number(values.threshold), anchor: values.anchor, unlabelled: values.unlabelled, minConfidence: Number(values['min-confidence']) || 0 });
  const text = markdown(report, values.title);
  if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
  if (values.md) writeFileSync(values.md, `${text}\n`);
  if (!values.quiet) console.log(text);
  if (values.quiet && (values.json || values.md)) console.log(`wrote ${[values.json, values.md].filter(Boolean).join(' and ')} — ${report.recommendation.verdict}`);
}
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch(error => { console.error(error); process.exitCode = 1; });
