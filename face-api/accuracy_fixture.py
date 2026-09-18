"""Build the inputs for scripts/accuracy.mjs from images, through a running face service (W3-D).

Two subcommands, both talking to the same /extract endpoint the Worker calls, so the embeddings,
appearance rows and zero-face outcomes are exactly what indexing would have stored:

  extract   a folder of consented originals + labels.csv  ->  photos.json, faces.json,
            appearances.json (the D1 export shape) and a copy of the labels. Use it to measure a
            real session locally instead of exporting D1 (same numbers, no data leaves the machine
            it runs on), or to measure HOG person-detector recall on originals.

  synthetic a labelled group photo (default: insightface's bundled 6-face test image) plus, if
            present, its bundled single-face image  ->  a synthetic "session": per-person crops with
            flips / brightness / blur / re-encode / rotation / grayscale / distance augmentations,
            group and pair photos, zero-face "far away" photos with a confirmed burst link to a face
            photo of the same person, and no-person negatives. Then runs `extract` on it. Labels are
            derived, not hand-made, so the curve is only a mechanics check — say "synthetic" wherever
            its numbers are quoted.

  python accuracy_fixture.py extract  --photos DIR --labels labels.csv --out OUT [--url URL] [--key K]
  python accuracy_fixture.py synthetic --out OUT [--source t1.jpg] [--extra Tom_Hanks.png]
        [--background surf.jpg] [--negatives a.jpg b.jpg] [--url URL] [--key K]

Only Pillow, numpy and the standard library are used (both already in requirements.txt). The file is
not copied into the Space image (the Dockerfile copies main.py alone) and imports nothing from it.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

DEFAULT_URL = "http://127.0.0.1:7861/extract"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


# ── face service client ───────────────────────────────────────────────────────────────────────────
def post_image(url: str, data: bytes, filename: str, key: str | None = None, retries: int = 3) -> dict:
    """multipart POST like the Worker's extractFaces(); retries transient failures."""
    boundary = f"----accuracy{uuid.uuid4().hex}"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    if key:
        headers["x-face-key"] = key
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers), timeout=120) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in (401, 400, 413, 422):
                raise SystemExit(f"{filename}: face service answered {error.code} {error.read()[:200]!r}")
            if attempt == retries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                raise
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("unreachable")


def image_files(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES and not p.name.startswith("."))


# ── extract: folder + labels -> D1 export shape ───────────────────────────────────────────────────
def extract(photos_dir: Path, labels_path: Path | None, out: Path, url: str, key: str | None, quiet: bool = False) -> dict:
    """Photo ids are the file names (that is what labels.csv refers to when there is no D1 export)."""
    out.mkdir(parents=True, exist_ok=True)
    photos, faces, appearances = [], [], []
    files = image_files(photos_dir)
    if not files:
        raise SystemExit(f"no images in {photos_dir}")
    started = time.perf_counter()
    for index, path in enumerate(files, 1):
        data = path.read_bytes()
        try:
            result = post_image(url, data, path.name, key)
        except Exception as error:  # a photo the service cannot process is 'failed', like the queue consumer's final state
            photos.append({"id": path.name, "filename": path.name, "indexing_status": "failed", "captured_at": None})
            if not quiet:
                print(f"  {path.name}: failed ({error})", file=sys.stderr)
            continue
        photos.append({"id": path.name, "filename": path.name, "indexing_status": "completed", "captured_at": result.get("captured_at")})
        for face in result.get("faces", []):
            faces.append({"id": f"{path.name}#{len(faces)}", "photo_id": path.name, "embedding_json": json.dumps(face["embedding"]),
                          "bbox_json": json.dumps(face.get("bbox_norm")), "confidence": face.get("confidence")})
        if result.get("appearance"):
            appearances.append({"photo_id": path.name, "bbox_json": json.dumps(result["appearance"].get("bbox_norm"))})
        if not quiet and (index % 10 == 0 or index == len(files)):
            print(f"  {index}/{len(files)} photos, {len(faces)} faces, {len(appearances)} appearance rows, {time.perf_counter() - started:.1f}s", file=sys.stderr)
    (out / "photos.json").write_text(json.dumps(photos, indent=1))
    (out / "faces.json").write_text(json.dumps(faces))
    (out / "appearances.json").write_text(json.dumps(appearances, indent=1))
    if labels_path and labels_path.resolve() != (out / "labels.csv").resolve():
        (out / "labels.csv").write_text(labels_path.read_text())
    summary = {"photos": len(photos), "completed": sum(p["indexing_status"] == "completed" for p in photos), "faces": len(faces),
               "photos_with_face": len({f["photo_id"] for f in faces}), "appearance_rows": len(appearances), "seconds": round(time.perf_counter() - started, 1)}
    (out / "extract-summary.json").write_text(json.dumps(summary, indent=1))
    return summary


# ── synthetic: augmentations of a labelled group photo ────────────────────────────────────────────
def to_jpeg(image: Image.Image, quality: int = 90) -> bytes:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, "JPEG", quality=quality)
    return buffer.getvalue()


def crop_around(image: Image.Image, box: list[float], wide: float, tall: float) -> Image.Image:
    """Crop centred on a face box, `wide`/`tall` times its size, clamped to the frame."""
    x1, y1, x2, y2 = box
    cx, cy, w, h = (x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1
    left, top = max(0, int(cx - w * wide / 2)), max(0, int(cy - h * tall / 2))
    right, bottom = min(image.width, int(cx + w * wide / 2)), min(image.height, int(cy + h * tall / 2))
    return image.crop((left, top, right, bottom))


def place_far(crop: Image.Image, face_width: float, target_face_px: int, background: Image.Image, seed: int) -> Image.Image:
    """Shrink a person crop so the face is `target_face_px` wide and paste it onto a real scene, the
    way a distant surfer sits in a frame — the detector then has to find a small face in a big photo."""
    scale = target_face_px / face_width
    small = crop.resize((max(8, int(crop.width * scale)), max(8, int(crop.height * scale))), Image.LANCZOS)
    canvas = background.copy()
    x = (seed * 173) % max(1, canvas.width - small.width)
    y = (seed * 97) % max(1, canvas.height - small.height)
    canvas.paste(small, (x, y))
    return canvas


def occlude(crop: Image.Image, face_width: float) -> Image.Image:
    """A dark bar across the eye line (sunglasses / a hand) — the face is centred in these crops."""
    out = crop.copy()
    cx, cy = out.width / 2, out.height / 2
    band = int(face_width * 0.3)
    ImageDraw.Draw(out).rectangle([cx - face_width * 0.55, cy - band * 1.4, cx + face_width * 0.55, cy - band * 0.2], fill=(25, 25, 30))
    return out


def lowres(crop: Image.Image, factor: float) -> Image.Image:
    small = crop.resize((max(8, int(crop.width * factor)), max(8, int(crop.height * factor))), Image.BILINEAR)
    return small.resize(crop.size, Image.BILINEAR)


def solo_variants(crop: Image.Image, face_width: float, background: Image.Image, seed: int) -> dict[str, Image.Image]:
    """One identity's photos, easy to hard. `far`/`tiny` are the "surfer far away or turned" cases:
    the face is 22 px and 12 px wide, so detection usually fails and the photo is only reachable
    through a link. `occl`, `blur4`, `rot25`, `lowres`, `cast` and `far30` are the hard-but-detectable
    cases (sunglasses, spray, a tilted head, a heavy crop, water haze, distance) that push same-person
    scores down into the threshold band."""
    return {
        "orig": crop,
        "flip": ImageOps.mirror(crop),
        "bright": ImageEnhance.Brightness(crop).enhance(1.55),
        "dark": ImageEnhance.Brightness(crop).enhance(0.5),
        "blur": crop.filter(ImageFilter.GaussianBlur(2.5)),
        "jpeg20": Image.open(io.BytesIO(to_jpeg(crop, 20))),
        "rot12": crop.rotate(12, resample=Image.BICUBIC, expand=False, fillcolor=(90, 110, 130)),
        "gray": ImageOps.grayscale(crop).convert("RGB"),
        "small": place_far(crop, face_width, 44, background, seed),
        "far": place_far(crop, face_width, 22, background, seed + 1),
        "tiny": place_far(crop, face_width, 12, background, seed + 2),
        "occl": occlude(crop, face_width),
        "blur4": crop.filter(ImageFilter.GaussianBlur(4)),
        "rot25": crop.rotate(25, resample=Image.BICUBIC, expand=False, fillcolor=(90, 110, 130)),
        "lowres": lowres(crop, 0.22),
        "cast": ImageEnhance.Contrast(Image.blend(crop, Image.new("RGB", crop.size, (40, 150, 170)), 0.35)).enhance(0.7),
        "far30": place_far(crop.filter(ImageFilter.GaussianBlur(1)), face_width, 30, background, seed + 3),
    }


def synthetic(out: Path, source: Path, extra: Path | None, background: Path | None, negatives: list[Path], url: str, key: str | None) -> dict:
    photos_dir = out / "photos"
    photos_dir.mkdir(parents=True, exist_ok=True)
    labels: list[tuple[str, str]] = []
    links: list[dict] = []

    def save(name: str, image: Image.Image, surfers: list[str], quality: int = 90) -> str:
        filename = f"{name}.jpg"
        (photos_dir / filename).write_bytes(to_jpeg(image, quality))
        for surfer in (surfers or ["-"]):
            labels.append((filename, surfer))
        return filename

    group = ImageOps.exif_transpose(Image.open(source)).convert("RGB")
    detected = post_image(url, to_jpeg(group, 95), source.name, key)["faces"]
    if len(detected) < 2:
        raise SystemExit(f"{source}: need a group photo with several faces, the service found {len(detected)}")
    boxes = sorted((face["bbox"] for face in detected), key=lambda box: box[0])   # left to right → s1, s2, …
    scene = ImageOps.exif_transpose(Image.open(background)).convert("RGB") if background else Image.new("RGB", (1200, 800), (70, 120, 150))
    if max(scene.size) > 1200:
        scene.thumbnail((1200, 1200))
    # Blurred so the scene itself contributes no face: unblurred, the surf photo yielded a borderline
    # (0.5-confidence) back-of-head detection once a patch was pasted near it, and that one embedding
    # then "matched" itself at 0.99 across twenty photos labelled as seven different people.
    scene = scene.filter(ImageFilter.GaussianBlur(6))

    for index, box in enumerate(boxes, 1):
        surfer = f"s{index}"
        crop = crop_around(group, box, 2.6, 3.2)
        for variant, image in solo_variants(crop, box[2] - box[0], scene, index).items():
            save(f"{surfer}-{variant}", image, [surfer], 20 if variant == "jpeg20" else 90)
        save(f"{surfer}-tight", crop_around(group, box, 1.15, 1.15), [surfer])
    everyone = [f"s{i}" for i in range(1, len(boxes) + 1)]
    save("group-orig", group, everyone)
    save("group-flip", ImageOps.mirror(group), everyone)
    save("group-dark", ImageEnhance.Brightness(group).enhance(0.55), everyone)
    save("group-half", group.resize((group.width // 2, group.height // 2), Image.LANCZOS), everyone)
    save("group-blur", group.filter(ImageFilter.GaussianBlur(2)), everyone)
    for i in range(0, len(boxes) - 1, 2):   # neighbouring pairs → two labels
        a, b = boxes[i], boxes[i + 1]
        merged = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
        save(f"pair-s{i + 1}-s{i + 2}", crop_around(group, merged, 1.5, 2.2), [f"s{i + 1}", f"s{i + 2}"])
    if extra and extra.exists():
        # A second source image: one more identity that never appears in the group photo.
        face = ImageOps.exif_transpose(Image.open(extra)).convert("RGB")
        if max(face.size) < 400:   # insightface ships an aligned 112 px crop; give the detector context
            face = face.resize((448, 448), Image.LANCZOS)
        canvas = Image.new("RGB", (face.width * 2, face.height * 2), (120, 140, 160))
        canvas.paste(face, (face.width // 2, face.height // 2))
        surfer = f"s{len(boxes) + 1}"
        for variant, image in solo_variants(canvas, face.width, scene, 40).items():
            if variant in ("orig", "flip", "dark", "blur", "small", "far", "occl", "rot25", "lowres", "cast"):
                save(f"{surfer}-{variant}", image, [surfer])
    for path in negatives:
        save(f"none-{path.stem}", ImageOps.exif_transpose(Image.open(path)).convert("RGB"), ["-"])

    labels_path = out / "labels.csv"
    with labels_path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["photo_id", "surfer_id"])
        writer.writerows(labels)
    print(f"synthetic set: {len(set(p for p, _ in labels))} photos in {photos_dir}", file=sys.stderr)
    summary = extract(photos_dir, labels_path, out, url, key)

    # Confirmed burst links for the zero-face photos, the way the fallback would cover a surfer who
    # turned away: each links to that person's `orig` photo. Written after extraction because which
    # photos end up faceless is the detector's call, not ours.
    faces = json.loads((out / "faces.json").read_text())
    with_face = {face["photo_id"] for face in faces}
    by_photo: dict[str, list[str]] = {}
    for photo_id, surfer in labels:
        by_photo.setdefault(photo_id, []).append(surfer)
    for photo_id, surfers in by_photo.items():
        if photo_id in with_face or surfers == ["-"] or len(surfers) != 1:
            continue
        links.append({"id": uuid.uuid4().hex, "photo1_id": f"{surfers[0]}-orig.jpg", "photo2_id": photo_id, "link_type": "burst", "score": 1.0, "status": "confirmed"})
    (out / "links.json").write_text(json.dumps(links, indent=1))
    summary["zero_face_links"] = len(links)
    (out / "extract-summary.json").write_text(json.dumps(summary, indent=1))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    ex = sub.add_parser("extract", help="run a folder of originals through the face service")
    ex.add_argument("--photos", type=Path, required=True)
    ex.add_argument("--labels", type=Path)
    ex.add_argument("--out", type=Path, required=True)
    sy = sub.add_parser("synthetic", help="build and extract the synthetic session")
    sy.add_argument("--out", type=Path, required=True)
    sy.add_argument("--source", type=Path, help="group photo with several faces (default: insightface's bundled t1.jpg)")
    sy.add_argument("--extra", type=Path, help="single-face image for one more identity (default: insightface's bundled Tom Hanks crop)")
    sy.add_argument("--background", type=Path, help="scene the 'far away' variants are pasted onto")
    sy.add_argument("--negatives", type=Path, nargs="*", default=[], help="photos with nobody in them (labelled '-')")
    for p in (ex, sy):
        p.add_argument("--url", default=os.environ.get("FACE_API_URL", DEFAULT_URL))
        p.add_argument("--key", default=os.environ.get("FACE_API_KEY") or None)
    args = parser.parse_args()
    if args.command == "extract":
        summary = extract(args.photos, args.labels, args.out, args.url, args.key)
    else:
        source, extra = args.source, args.extra
        if source is None or extra is None:
            try:
                import insightface  # noqa: F401 — only to locate its bundled test images
                images = Path(insightface.__file__).parent / "data" / "images"
                source = source or images / "t1.jpg"
                extra = extra or images / "Tom_Hanks_54745.png"
            except ImportError:
                raise SystemExit("pass --source (a group photo); insightface's bundled test image is not importable here")
        summary = synthetic(args.out, source, extra, args.background, args.negatives, args.url, args.key)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
