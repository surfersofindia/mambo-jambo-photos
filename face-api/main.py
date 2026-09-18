import hmac
import io
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime

import anyio
import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from PIL import ExifTags, Image, ImageOps
from pydantic import BaseModel

face_app = None

# How many /extract inferences may run at once. Inference is CPU-bound (onnxruntime + HOG) and
# runs in worker threads, so on the 2 vCPU Space more parallelism only adds contention; the cap
# makes a burst (queue consumer at max_concurrency 3 plus guest searches) queue in-process
# instead of piling threads onto two cores, while /health and the warm ping stay responsive.
# Created in lifespan because anyio binds the limiter to the running event loop.
INFERENCE_WORKERS = max(1, int(os.environ.get("FACE_MAX_INFERENCE", "2")))
inference_limiter = None

# Person detector for the body/clothing fallback signal. Ships inside opencv-python-headless
# already (no extra model download, no new dependency) — deliberately not a YOLO/torch stack,
# which would roughly double this container's image size and cold-start cost. Weaker than YOLO on
# crouched/mid-air action shots; swap detect_person_bbox() for an ONNX detector later if recall
# proves too low in practice — clothing_histogram() and everything downstream doesn't care which
# detector produced the box.
hog = cv2.HOGDescriptor()
hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())


HOG_WINDOW = (64, 128)  # width, height of cv2's default people-detector window
HOG_MAX_DIM = 800  # HOG's multi-scale sliding window is O(pixels); full-res DSLR frames (e.g.
# 6000x4000) made this take ~10s+ per photo. Coarse clothing-region detection doesn't need
# native resolution, so downscale first and map the result back to original pixel coordinates.


def configured_key() -> str:
    """Shared secret with the Worker (F2). Empty means the check is off, so a Space deployed
    before the secret exists keeps serving the current Worker. Read per request so tests can
    toggle it; whitespace is stripped because dashboard secrets are pasted by hand."""
    return os.environ.get("FACE_API_KEY", "").strip()


def detect_person_bbox(img):
    """Largest detected person box (x, y, w, h) in original-image pixel coordinates, or None."""
    h, w = img.shape[:2]
    scale = HOG_MAX_DIM / max(h, w) if max(h, w) > HOG_MAX_DIM else 1.0
    small = cv2.resize(img, (int(w * scale), int(h * scale))) if scale < 1.0 else img
    # OpenCV asserts (-> a 500 from /extract) when the frame is smaller than HOG's 64x128 window;
    # a thumbnail-sized image simply has no usable clothing region.
    if small.shape[0] < HOG_WINDOW[1] or small.shape[1] < HOG_WINDOW[0]:
        return None
    boxes, _ = hog.detectMultiScale(small, winStride=(8, 8))
    if len(boxes) == 0:
        return None
    largest = max(boxes, key=lambda b: b[2] * b[3])
    return largest / scale if scale < 1.0 else largest


def clothing_histogram(img, bbox):
    """Normalized HSV color histogram of the lower ~65% of the person box (skips head/hair)."""
    x, y, w, h = [int(v) for v in bbox]
    region = img[y + int(h * 0.35):y + h, x:x + w]
    if region.size == 0:
        return None
    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [30, 32], [0, 180, 0, 256])
    cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
    return hist.flatten().tolist()


def build_face_app():
    """Load InsightFace buffalo_l (downloaded to ~/.insightface on a fresh container, ~275 MB).
    Imported here rather than at module level so test_auth.py can stub the model without the
    compiled insightface package installed."""
    from insightface.app import FaceAnalysis
    model = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    model.prepare(ctx_id=0, det_size=(640, 640))
    return model


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the model on startup. uvicorn only starts accepting connections once this returns, so
    a cold container answers nothing (not even /health) until the model is ready."""
    global face_app, inference_limiter
    inference_limiter = anyio.CapacityLimiter(INFERENCE_WORKERS)
    started = time.perf_counter()
    print("Loading InsightFace buffalo_l model...", flush=True)
    face_app = build_face_app()
    loaded = time.perf_counter()
    # onnxruntime allocates each model's arena on its first run; pay that here so the first real
    # photo after a cold start is not the slow one. get() on a blank frame only exercises the
    # detector (no face means recognition never runs), so every other model in the pack gets one
    # blank NCHW run too — without it the first face photo cost 9 s locally instead of 0.5 s.
    try:
        face_app.get(np.zeros((640, 640, 3), np.uint8))
    except Exception as error:  # never block startup on the warm-up
        print(f"Warm-up inference skipped: {error}", flush=True)
    for name, model in getattr(face_app, "models", {}).items():
        if name == "detection":
            continue
        try:
            width, height = model.input_size
            model.session.run(model.output_names, {model.input_name: np.zeros((1, 3, height, width), np.float32)})
        except Exception as error:
            print(f"Warm-up of {name} skipped: {error}", flush=True)
    # Recognition also aligns each face through scikit-image, which insightface imports lazily on
    # the first call: run one alignment on the identity template so that import is paid here too.
    try:
        from insightface.utils import face_align
        template = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                             [41.5493, 92.3655], [70.7299, 92.2041]], np.float32)
        face_align.norm_crop(np.zeros((112, 112, 3), np.uint8), template)
    except Exception as error:
        print(f"Warm-up of face alignment skipped: {error}", flush=True)
    print(f"Face model ready: load {loaded - started:.1f}s, warm-up {time.perf_counter() - loaded:.1f}s, "
          f"inference workers {INFERENCE_WORKERS}, key required {bool(configured_key())}.", flush=True)
    yield
    # Cleanup on shutdown (nothing needed)

app = FastAPI(title="Mambo Jambo Face API", lifespan=lifespan)


@app.middleware("http")
async def require_face_key(request: Request, call_next):
    """F2: when FACE_API_KEY is set, POST /extract needs a matching x-face-key. Only the expensive
    path is gated — /, /health and GET/HEAD /extract stay open so the Worker's health probe and
    warm ping keep working whichever side of the rollout has the secret first. Checking here,
    before the route parses the multipart body, means a rejected upload never touches the model
    or the image bytes."""
    key = configured_key()
    if key and request.method == "POST" and request.url.path.rstrip("/") == "/extract":
        supplied = request.headers.get("x-face-key", "")
        if not hmac.compare_digest(supplied.encode("utf-8", "replace"), key.encode("utf-8")):
            # Discard the upload (chunk by chunk, nothing is kept) before answering: closing the
            # socket with unread bytes makes the Space's proxy report a reset instead of this 401.
            async for _chunk in request.stream():
                pass
            return JSONResponse({"error": "unauthorised"}, status_code=401)
    return await call_next(request)


class FaceResult(BaseModel):
    embedding: list[float]
    confidence: float
    bbox: list[float] | None = None
    bbox_norm: list[float] | None = None


class AppearanceResult(BaseModel):
    bbox_norm: list[float]
    histogram: list[float]


class ExtractResponse(BaseModel):
    faces: list[FaceResult]
    captured_at: str | None = None
    appearance: AppearanceResult | None = None


# EXIF tag ids (Exif IFD): DateTimeOriginal, falling back to the base DateTime tag.
DATE_TIME_ORIGINAL = next(k for k, v in ExifTags.TAGS.items() if v == "DateTimeOriginal")
DATE_TIME = next(k for k, v in ExifTags.TAGS.items() if v == "DateTime")


def extract_captured_at(image_bytes: bytes) -> str | None:
    """Best-effort EXIF capture timestamp. Returns None for missing/stripped/unparsable EXIF."""
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            exif = img.getexif()
            raw = exif.get(DATE_TIME_ORIGINAL) or exif.get(DATE_TIME)
            if not raw:
                # Some cameras store DateTimeOriginal only under the Exif sub-IFD.
                exif_ifd = exif.get_ifd(ExifTags.IFD.Exif)
                raw = exif_ifd.get(DATE_TIME_ORIGINAL)
            if not raw:
                return None
            return datetime.strptime(raw, "%Y:%m:%d %H:%M:%S").isoformat()
    except Exception:
        return None


def status_body():
    return {"status": "ok", "model_loaded": face_app is not None,
            "key_required": bool(configured_key()), "inference_workers": INFERENCE_WORKERS}


@app.get("/")
def root():
    return {"status": "ok", "message": "Mambo Jambo Face API is running."}


@app.get("/health")
def health():
    return status_body()


@app.api_route("/extract", methods=["GET", "HEAD"])
def extract_warm_ping():
    """Cheap warm ping for the Worker's cron and deep health check: GET and HEAD both answer 200
    with no body read, no image decode and no inference (FastAPI does not add HEAD to GET routes
    by itself, hence the explicit method list — the old service answered HEAD with 405). Open on
    purpose — it costs nothing and must work before the shared secret is rolled out."""
    return status_body()


def decode_oriented_bgr(image_bytes: bytes):
    """Decode to an OpenCV BGR array with EXIF orientation baked in first. cv2.imdecode ignores
    EXIF entirely, but plenty of phone selfies store landscape sensor pixels plus a rotation tag
    rather than physically rotating them — fed straight to the detector, a face that's actually
    upright on screen arrives sideways in the pixel data, and neither the face detector nor the
    HOG person detector is rotation-invariant enough to find it. Returns None on undecodable data,
    matching cv2.imdecode's None-on-failure so callers don't need to know which decoder ran."""
    try:
        with Image.open(io.BytesIO(image_bytes)) as pil_img:
            upright = ImageOps.exif_transpose(pil_img)
            return cv2.cvtColor(np.array(upright.convert("RGB")), cv2.COLOR_RGB2BGR)
    except Exception:
        return None


def analyse_image(image_bytes: bytes) -> ExtractResponse:
    """The CPU-bound part of /extract (decode, EXIF, faces, person + clothing). Runs in a worker
    thread under inference_limiter so the event loop — and with it /health and the warm ping —
    never blocks on inference; concurrent calls beyond the cap queue in order rather than fail.
    onnxruntime and OpenCV release the GIL, so up to INFERENCE_WORKERS calls truly overlap."""
    img = decode_oriented_bgr(image_bytes)
    if img is None:
        raise HTTPException(status_code=400, detail="Could not decode the uploaded image. Please use a JPG or PNG.")

    captured_at = extract_captured_at(image_bytes)
    h, w, _ = img.shape
    faces = face_app.get(img)

    results = []
    for face in faces:
        emb = face.embedding.tolist()
        conf = float(face.det_score)
        bbox = [float(c) for c in face.bbox]
        x1, y1, x2, y2 = bbox
        bw = x2 - x1
        bh = y2 - y1
        px = bw * 0.25
        py = bh * 0.25
        fx1 = max(0, x1 - px)
        fy1 = max(0, y1 - py)
        fx2 = min(w, x2 + px)
        fy2 = min(h, y2 + py)

        bbox_norm = [
            round((fy1 / h) * 100, 2),
            round((fx1 / w) * 100, 2),
            round(((fx2 - fx1) / w) * 100, 2),
            round(((fy2 - fy1) / h) * 100, 2)
        ]
        results.append(FaceResult(
            embedding=emb,
            confidence=conf,
            bbox=bbox,
            bbox_norm=bbox_norm
        ))

    appearance = None
    person_bbox = detect_person_bbox(img)
    if person_bbox is not None:
        histogram = clothing_histogram(img, person_bbox)
        if histogram is not None:
            bx, by, bwidth, bheight = [float(v) for v in person_bbox]
            appearance = AppearanceResult(
                bbox_norm=[
                    round((by / h) * 100, 2),
                    round((bx / w) * 100, 2),
                    round((bwidth / w) * 100, 2),
                    round((bheight / h) * 100, 2)
                ],
                histogram=histogram
            )

    return ExtractResponse(faces=results, captured_at=captured_at, appearance=appearance)


@app.post("/extract", response_model=ExtractResponse)
async def extract_faces(file: UploadFile = File(...)):
    if face_app is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet. Retry in a few seconds.")
    try:
        image_bytes = await file.read()
        return await anyio.to_thread.run_sync(analyse_image, image_bytes, limiter=inference_limiter)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal error processing image: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 7860)))
