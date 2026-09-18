# Matching accuracy — how to measure it, and what we know so far

**Status (2026-09-17, W3-D):** the measurement tooling is built and validated end-to-end on a synthetic set with real 512-d InsightFace embeddings. **No real session has been measured yet** — the user had not nominated a consented session this wave. Until that run happens the recommendation is **`MATCH_THRESHOLD` unchanged at 0.62**. Section 3 is the procedure the crew follows on the nominated session; section 4 is where its numbers go.

The pipeline being measured is the one that ships: `POST /api/match` in `worker.js` — cosine similarity between the selfie embedding and every stored face, the best face per photo, `score >= MATCH_THRESHOLD`, sorted, capped at 80, then every **confirmed** burst/appearance link pulls in its other photo at 0.9 × the anchor's score. `scripts/accuracy.mjs` replicates that ranking and its `--selftest` runs the real handler from `worker.js` on the same fixture and requires identical output, so the numbers here are the guest's numbers, not a model benchmark.

## 1. Tools

| File | What it does |
|---|---|
| `scripts/accuracy.mjs` | Plain Node (22+), no dependencies. Reads the session export (`photos`, `faces`, optional `photo_links` and `photo_appearances`) plus `labels.csv`, and writes a Markdown report (stdout or `--md`) and a JSON report (`--json`) with precision / recall / F1 at every threshold from 0.55 to 0.70, the per-surfer breakdown, the score distribution, zero-face counts, label-hygiene checks and the HOG person-detector numbers. `--selftest` runs the bundled fixture and the worker-agreement check. `--template` writes a `labels.csv` to fill in. |
| `face-api/accuracy_fixture.py` | Python (Pillow + stdlib only, both already in `requirements.txt`; **not** copied into the Space image). `extract` runs a folder of originals through a face service and writes the same export shape (for a local run without D1, or to measure HOG on originals). `synthetic` builds and extracts the synthetic session used in section 5. |

```sh
node scripts/accuracy.mjs --selftest                     # 8 queries, 16 thresholds, worker.js agrees → exit 0
node scripts/accuracy.mjs --help
```

## 2. Metric

- **Query:** every labelled surfer, once per *clean* face — a photo labelled with exactly that one surfer that holds exactly one detected face, so the face is certainly theirs. That face stands in for the guest's selfie. (`--anchor best` also uses the most confident face of single-surfer photos with several faces; noisier, because the confident face may be a bystander.)
- **Leave-one-out:** the query photo is removed from the gallery, the remaining completed photos are ranked exactly as `/api/match` ranks them.
- **Relevant:** every other photo labelled with that surfer, *including photos with no detected face* — those are only reachable through a confirmed link, which is the fallback's job, and they count as misses when nothing reaches them. `recall (face)` in the report restricts to photos that do have a face, which isolates the recogniser from the fallback.
- **Precision / recall / F1** are micro-averaged over all queries (sum of TP / FP / FN); `mean query precision` is the per-query average. Photos missing from `labels.csv` are ignored by default (`--unlabelled negative` counts them as wrong results).
- **Recommendation rule** (`recommend()` in the script): the threshold only moves off the current value with at least 20 queries, a candidate with precision ≥ 0.90 and an F1 gain of at least 0.02. Otherwise "keep".

Targets from the program: **≥ 90 % precision at the shipped threshold** (a guest must not be shown someone else's photo); recall is the second lever, and the score-distribution paragraph (same-surfer p10 vs other-people p99) says how much room there is.

## 3. Running it on a real session (the pending step)

**Consent first.** Pick one published session where every surfer whose face will be labelled has agreed to it. Labels are opaque ids (`s1`, `s2`, …), never names or phone numbers. The export contains face embeddings: keep it on one machine, do not commit it, delete it after the report is written. The report itself (`report.md` / `report.json`) contains only counts and photo ids.

### 3a. Export the session from D1

Replace `SESSION_ID` (from the crew studio's session card, or `SELECT id, title FROM sessions`). Every command is a read; `--json` prints `[{ "results": [...] }]`, which the script accepts as is.

```sh
S=SESSION_ID
npx wrangler d1 execute mambo-jambo-photos --remote --json --command "SELECT id, filename, indexing_status, captured_at FROM photos WHERE session_id = '$S' ORDER BY captured_at, filename" > photos.json
npx wrangler d1 execute mambo-jambo-photos --remote --json --command "SELECT f.id, f.photo_id, f.embedding_json, f.bbox_json, f.confidence FROM faces f JOIN photos p ON p.id = f.photo_id WHERE p.session_id = '$S' ORDER BY f.photo_id, f.created_at" > faces.json
npx wrangler d1 execute mambo-jambo-photos --remote --json --command "SELECT id, photo1_id, photo2_id, link_type, score, status FROM photo_links WHERE session_id = '$S'" > links.json
npx wrangler d1 execute mambo-jambo-photos --remote --json --command "SELECT pa.photo_id, pa.bbox_json FROM photo_appearances pa JOIN photos p ON p.id = pa.photo_id WHERE p.session_id = '$S'" > appearances.json
```

A face row is ~6 KB of JSON (512 floats). If wrangler refuses a large `faces` result, page it — `… ORDER BY f.id LIMIT 500 OFFSET 0`, `OFFSET 500`, … into `faces-1.json`, `faces-2.json` — and pass `--faces faces-1.json,faces-2.json`. To size the session first (also a read):

```sh
npx wrangler d1 execute mambo-jambo-photos --remote --command "SELECT COUNT(DISTINCT p.id) AS photos, SUM(p.indexing_status = 'completed') AS completed, COUNT(f.id) AS faces, COUNT(DISTINCT f.photo_id) AS photos_with_face FROM photos p LEFT JOIN faces f ON f.photo_id = p.id WHERE p.session_id = '$S'"
```

### 3b. Label the photos

```sh
node scripts/accuracy.mjs --photos photos.json --template labels.csv
```

writes `photo_id,filename,surfer_id` with one row per completed photo. Open it in a spreadsheet next to the studio's photo grid and fill in `surfer_id`: one row per labelled surfer visible in the photo (duplicate the row for a second surfer), `-` when none of the labelled surfers is in it. Label people you can identify **whatever the camera saw** — a surfer with their back to the camera is labelled too; that is exactly what the zero-face and link numbers measure. Leave a row's `surfer_id` empty only if you genuinely do not know; those photos are then excluded rather than counted. Two rules of thumb the report checks for you: a photo with more detected faces than labels holds a bystander or a missed label; a single-face photo whose face is not the labelled surfer becomes a wrong query and shows up under "suspect queries".

### 3c. Run and read

```sh
node scripts/accuracy.mjs --photos photos.json --faces faces.json --links links.json --appearances appearances.json \
  --labels labels.csv --threshold 0.62 --md report.md --json report.json --title "Session <title> <date>"
```

Then:

1. **Label and detection checks** — fix anything listed under *suspect queries* and *more faces than labels* before trusting the rest; re-run.
2. **Precision at 0.62** — the program target is ≥ 90 %. If it is lower, look at the *other people* p99 / max in the score distribution: a max above 0.62 means real lookalikes (or wet-hair / sunglasses / distance making everyone look alike); those pairs are what the crew's face-pair review queue exists for.
3. **Recall and `recall (face)`** — the gap between them is the fallback's job (zero-face photos); *zero-face reached* says how many of those a confirmed link actually pulled in. `empty` queries are guests who would see the zero-match screen.
4. **The recommendation line** — paste the threshold table and the recommendation into section 4 of this file. If the rule says move, change `MATCH_THRESHOLD` in `wrangler.jsonc` (deploy is a separate decision), and re-run the *Scan Burst & Appearance Links* pass afterwards, because burst candidates are only generated for pairs whose faces do **not** already clear the threshold.
5. **HOG** — the last table (see 3d).
6. Optional what-if: `--min-confidence 0.6` drops faces the detector was unsure about (confidence < 0.6) from the gallery and shows what a confidence gate in the service or Worker would do to the curve. The Worker stores every face today.

### 3d. HOG person-detector recall on the real session

The appearance signal (`README.md`, "Body/clothing appearance matching") needs OpenCV's HOG pedestrian detector to find the surfer *and* to find the right one. The D1 export already answers both without touching the originals:

- **Recall given a face** — share of face photos with a `photo_appearances` row (HOG produced *some* person box).
- **Person box contains a detected face** — `photo_appearances.bbox_json` vs `faces.bbox_json`: does the box hold one of the detected faces? If not, the histogram describes a bystander, a board or noise.
- **Recall of the right person** — the product; this is the number to quote for "HOG recall".
- **Rate given no face** — zero-face photos with a row. Unverifiable from the export (there is no face to check against); a spot check of `bbox_json` on a few of those photos in the studio's photo grid is the honest way to judge it.
- **Linkable pair share** — both ends of an appearance link need a row, so this is the share of (faceless, with-face) pairs the signal can score at all.

To measure on originals instead (for example on a laptop that has the session's JPEGs and a local face service on port 7861): `python face-api/accuracy_fixture.py extract --photos ./originals --labels labels.csv --out ./export --url http://127.0.0.1:7861/extract`, then run the script on `./export`. Photo ids are then file names, so `labels.csv` must use file names too.

## 4. Real-session results

_Not run yet. Paste the session title/date, photo/face/query counts, the threshold table, the score-distribution line, the HOG table and the recommendation here. Keep the synthetic section below as the baseline it is compared against._

**Recommendation until then: `MATCH_THRESHOLD = 0.62` (unchanged).**

## 5. Synthetic validation (labelled synthetic — not a real-session number)

Built with `face-api/accuracy_fixture.py synthetic` and the real `buffalo_l` models (`det_10g` + `w600k_r50`) served by `face-api/main.py` on port 7861. Source: InsightFace's bundled six-face test photo (`t1.jpg`, six adults around a table, upper bodies) and its bundled single-face crop, so **seven identities from one studio-lit photo**. Each identity got a head-and-shoulders crop and 17 variants (flip, brightness ±, blur 2.5 and 4, JPEG q20, 12° and 25° tilt, grayscale, an eye-line occlusion bar, low resolution, a blue-green colour cast, and the crop shrunk to a 44 / 30 / 22 / 12 px face pasted on a blurred surf scene), a very tight crop, five whole-group variants, three two-person crops, and the two real surf photos from `assets/` as "nobody labelled" negatives. Photos where the detector found no face were given a confirmed burst link to that identity's original crop, the way the fallback would cover a surfer who turned away.

Full artefacts: `docs/audit/handoff/shots/W3-D/synthetic-report.md` / `.json`, `synthetic-breakdown.md`, `synthetic-curve-1024.png`.

**Session:** 128 photos, 135 faces on 107 photos, 21 zero-face photos (19 labelled), 7 identities, **99 queries**, 19 confirmed links.

| Threshold | Precision | Recall | F1 | Recall (face) | TP | FP | FN | Via link | Zero-face reached | Empty |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.55 | 100.0% | 97.0% | 98.5% | 97.7% | 2099 | 0 | 66 | 248 | 248/271 | 0 |
| 0.58 | 100.0% | 96.4% | 98.1% | 97.0% | 2086 | 0 | 79 | 248 | 248/271 | 0 |
| 0.60 | 100.0% | 95.2% | 97.5% | 95.8% | 2060 | 0 | 105 | 245 | 245/271 | 0 |
| **0.62 (current)** | **100.0%** | **94.0%** | **96.9%** | **94.5%** | 2035 | 0 | 130 | 245 | 245/271 | 0 |
| 0.64 | 100.0% | 91.8% | 95.7% | 92.5% | 1988 | 0 | 177 | 236 | 236/271 | 0 |
| 0.66 | 100.0% | 90.0% | 94.8% | 90.4% | 1949 | 0 | 216 | 236 | 236/271 | 0 |
| 0.68 | 100.0% | 87.6% | 93.4% | 88.0% | 1897 | 0 | 268 | 231 | 231/271 | 0 |
| 0.70 | 100.0% | 84.4% | 91.5% | 84.4% | 1827 | 0 | 338 | 228 | 228/271 | 0 |

Score distribution: same surfer n=1894, min 0.311, p10 0.666, median 0.860 · other people n=8600, median 0.018, p99 0.205, **max 0.260**. Recommendation printed by the tool: keep 0.62.

**What this does and does not say.** Precision is 100 % at every threshold because seven strangers from one photo have no lookalikes — the highest cross-identity score is 0.26, far below the band. That is the property real sessions will *not* have (siblings, similar builds under the same wet hair, sunglasses on everyone), so the synthetic curve says nothing about where precision starts to fall. It does show the shipped mechanics behaving: recall falls monotonically from 97 % to 84 % across the band as the hard variants drop out, zero-face photos are reached only through their link and only when the linked photo is itself matched (of the 26 unreached cases at 0.62, 19 are queries *from* the linked original, which leave-one-out removes, and 7 are queries that did not match the original at that threshold), and every pending/rejected link is ignored. Which variants push a same-person score into the band (mean similarity to the identity's original crop): occlusion bar 0.75 (0.71–0.78), blur 4 px 0.61 (0.48–0.67), 22 px face 0.73, low resolution 0.81 (0.63–0.99), blur 2.5 0.85; brightness (0.86, min 0.79), colour cast, tilt up to 25°, grayscale and JPEG q20 all average 0.86–0.99. Detection failed on all six very tight crops, all 12 px faces and four of seven 22 px faces — a face that fills the frame edge-to-edge, or is under ~25 px, is not indexed at all.

What-if confidence gate on the same set: dropping faces with detector confidence < 0.6 (4 faces) moves recall at 0.62 from 94.0 % to 91.2 %; < 0.7 (16 faces) to 88.4 %; precision stays 100 %. On this set every low-confidence detection was a real face, so the gate only costs. On real data a gate might remove borderline back-of-head detections — while building this set, an unblurred surf background produced one such 0.50-confidence detection that then "matched itself" at 0.99 across twenty photos labelled as seven different people, which is the bystander failure the *suspect queries* check is for.

**HOG person detector on the synthetic set** (`synthetic-breakdown.md`):

| Photo class | Photos | With a face | Any person box | Box contains the detected face |
|---|---|---|---|---|
| Whole group photo (six people, upper bodies) | 5 | 5 | 5 (100 %) | yes on all 5 |
| Two-person crops | 3 | 3 | 1 (33 %) | yes |
| Head-and-shoulders crops (all variants) | 92 | 86 | 9 of 86 (10 %) | 6 of 9 |
| Small person pasted on the blurred surf scene | 26 | 13 | 26 (100 %) | **1 of 13** — the box is the scene's own surfer, not the pasted person |
| Real surf photos from `assets/` (drone view, no face) | 2 | 0 | 2 (100 %) | unverifiable (no face) |

Overall: any box on 26 % of face photos; 13 of the 28 boxes contain a detected face; **recall of the right person 12 %**. HOG is a full-body pedestrian detector, so this is expected — it finds standing figures and misses head-and-shoulders framings and small distant people entirely. None of these framings is a surf photo; the real-session table from 3d is the number that matters, and a low one there is the signal to swap `detect_person_bbox()` for an ONNX person detector as the README already anticipates.

## 6. Caveats and follow-ups

- Nothing here touches the Space's runtime; `face-api/main.py` is unchanged this wave and no debug endpoint was added.
- The fixture's labels are derived from how it was built, not by a person, so the synthetic numbers are a mechanics check. Every number in section 5 is labelled synthetic on purpose.
- Suggested test hook (needs a `tests/` edit, not in this workstream's ownership): a `tests/accuracy.test.mjs` that runs `node scripts/accuracy.mjs --selftest` via `child_process.execFileSync` and asserts exit 0, so `npm test` guards the worker agreement.
- Worth measuring on the real run beyond the script: how many guests' actual selfies (phone, front camera, beach light) score against their own session photos — the leave-one-out proxy uses session photos as selfies, which are shot with the same camera and lens as the gallery and are therefore easier than a real selfie.
