import io
import os
from datetime import datetime

import cv2
import numpy as np
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, UploadFile, File
from pydantic import BaseModel
from PIL import ExifTags, Image
from insightface.app import FaceAnalysis

face_app = None

# Person detector for the body/clothing fallback signal. Ships inside opencv-python-headless
# already (no extra model download, no new dependency) — deliberately not a YOLO/torch stack,
# which would roughly double this container's image size and cold-start cost. Weaker than YOLO on
# crouched/mid-air action shots; swap detect_person_bbox() for an ONNX detector later if recall
# proves too low in practice — clothing_histogram() and everything downstream doesn't care which
# detector produced the box.
hog = cv2.HOGDescriptor()
hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())


HOG_MAX_DIM = 800  # HOG's multi-scale sliding window is O(pixels); full-res DSLR frames (e.g.
# 6000x4000) made this take ~10s+ per photo. Coarse clothing-region detection doesn't need
# native resolution, so downscale first and map the result back to original pixel coordinates.


def detect_person_bbox(img):
    """Largest detected person box (x, y, w, h) in original-image pixel coordinates, or None."""
    h, w = img.shape[:2]
    scale = HOG_MAX_DIM / max(h, w) if max(h, w) > HOG_MAX_DIM else 1.0
    small = cv2.resize(img, (int(w * scale), int(h * scale))) if scale < 1.0 else img
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the InsightFace model on startup (downloaded to /root/.insightface on first run)."""
    global face_app
    print("Loading InsightFace buffalo_l model...")
    face_app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    face_app.prepare(ctx_id=0, det_size=(640, 640))
    print("Face model ready.")
    yield
    # Cleanup on shutdown (nothing needed)

app = FastAPI(title="Mambo Jambo Face API", lifespan=lifespan)


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


@app.get("/")
def root():
    return {"status": "ok", "message": "Mambo Jambo Face API is running."}


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": face_app is not None}


@app.post("/extract", response_model=ExtractResponse)
async def extract_faces(file: UploadFile = File(...)):
    if face_app is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet. Retry in a few seconds.")
    try:
        image_bytes = await file.read()
        np_arr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
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

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal error processing image: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 7860)))
