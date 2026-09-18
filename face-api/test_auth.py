"""Auth, warm-ping and concurrency checks for the face service (F2, Space half).

Runs against the FastAPI app in-process with the InsightFace model stubbed, so it needs only
fastapi, httpx<0.28 (Starlette 0.36's TestClient still passes app= to httpx), Pillow, numpy,
opencv-python-headless and pytest — not the compiled insightface package or the buffalo_l
download. From face-api/:  python -m pytest -q test_auth.py
"""
import io
import os
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402

KEY = "test-secret-key"


class FakeModel:
    """Stands in for insightface FaceAnalysis: counts calls, optionally sleeps like inference."""

    def __init__(self, delay=0.0):
        self.calls = 0
        self.delay = delay
        self.last_shape = None

    def get(self, img):
        self.calls += 1
        self.last_shape = img.shape
        if self.delay:
            time.sleep(self.delay)
        return []


def jpeg_bytes(size=(320, 240)):
    buffer = io.BytesIO()
    Image.new("RGB", size, (200, 120, 60)).save(buffer, "JPEG")
    return buffer.getvalue()


def jpeg_bytes_with_orientation(size, orientation):
    """A JPEG whose stored pixels are `size` (width, height) but tagged with an EXIF Orientation
    that requires rotation to view correctly — what many phones write for a portrait selfie shot
    on a landscape-mounted sensor: a landscape pixel grid plus a rotation tag, not physically
    rotated pixels."""
    buffer = io.BytesIO()
    img = Image.new("RGB", size, (200, 120, 60))
    exif = img.getexif()
    exif[0x0112] = orientation  # Orientation tag (Exif.Image.Orientation)
    img.save(buffer, "JPEG", exif=exif.tobytes())
    return buffer.getvalue()


@pytest.fixture
def service(monkeypatch):
    """Yields (client, model) for a started app; `key` sets FACE_API_KEY, `delay` slows the model."""
    stack = []

    def start(key=None, delay=0.0):
        model = FakeModel(delay)
        monkeypatch.setattr(main, "build_face_app", lambda: model)
        if key is None:
            monkeypatch.delenv("FACE_API_KEY", raising=False)
        else:
            monkeypatch.setenv("FACE_API_KEY", key)
        client = TestClient(main.app).__enter__()
        stack.append(client)
        model.calls = 0  # ignore the startup warm-up inference
        return client, model

    yield start
    for client in stack:
        client.__exit__(None, None, None)


def post_extract(client, headers=None):
    return client.post("/extract", files={"file": ("photo.jpg", jpeg_bytes(), "image/jpeg")}, headers=headers or {})


def test_without_key_extract_is_open_and_unchanged(service):
    client, model = service()
    response = post_extract(client)
    assert response.status_code == 200
    body = response.json()
    assert body["faces"] == [] and body["captured_at"] is None and "appearance" in body
    assert model.calls == 1
    # Behaviour that must not change: a missing file is a 422 from FastAPI, an undecodable one a 400.
    assert client.post("/extract").status_code == 422
    bad = client.post("/extract", files={"file": ("x.jpg", b"not an image", "image/jpeg")})
    assert bad.status_code == 400
    assert client.get("/health").json()["key_required"] is False


def test_tiny_image_is_not_a_server_error(service):
    # Smaller than HOG's 64x128 window: OpenCV used to assert and /extract answered 500.
    client, _ = service()
    tiny = client.post("/extract", files={"file": ("tiny.jpg", jpeg_bytes((48, 48)), "image/jpeg")})
    assert tiny.status_code == 200
    assert tiny.json()["faces"] == [] and tiny.json()["appearance"] is None


def test_exif_orientation_is_applied_before_detection(service):
    # Stored as a 320x240 (w x h) landscape pixel grid tagged orientation=6 ("rotate 90 CW to
    # view correctly") — exactly what many phones write for a portrait selfie taken on a
    # landscape-mounted sensor. Before decode_oriented_bgr existed, cv2.imdecode ignored the tag
    # and fed the model that 240-tall x 320-wide frame sideways; a face upright on screen would
    # arrive rotated 90 degrees, which the detector is not rotation-invariant enough to find.
    client, model = service()
    rotated = jpeg_bytes_with_orientation((320, 240), orientation=6)
    response = client.post("/extract", files={"file": ("selfie.jpg", rotated, "image/jpeg")})
    assert response.status_code == 200
    # The model must see the corrected 240-wide x 320-tall frame, not the raw stored 320x240 one.
    assert model.last_shape[:2] == (320, 240)  # (height, width)


def test_with_key_post_extract_requires_matching_header(service):
    client, model = service(key=KEY)
    for headers in ({}, {"x-face-key": "wrong"}, {"x-face-key": KEY + "x"}, {"x-face-key": ""}):
        response = post_extract(client, headers)
        assert response.status_code == 401, headers
        assert response.json() == {"error": "unauthorised"}
    assert model.calls == 0  # rejected before any decoding or inference
    ok = post_extract(client, {"x-face-key": KEY})
    assert ok.status_code == 200 and ok.json()["faces"] == []
    assert model.calls == 1


def test_key_whitespace_is_tolerated(service):
    client, _ = service(key=f"  {KEY}\n")
    assert post_extract(client, {"x-face-key": KEY}).status_code == 200


def test_health_root_and_warm_ping_stay_open_with_key(service):
    client, model = service(key=KEY)
    assert client.get("/health").status_code == 200
    assert client.get("/health").json()["key_required"] is True
    assert client.get("/").status_code == 200
    assert client.get("/extract").status_code == 200
    assert client.head("/extract").status_code == 200
    assert model.calls == 0


def test_warm_ping_does_not_touch_the_model(service):
    client, model = service()
    get = client.get("/extract")
    assert get.status_code == 200
    assert get.json()["model_loaded"] is True and get.json()["status"] == "ok"
    # (uvicorn strips the HEAD body on the wire; the in-process test client does not, so only
    # the status is asserted here — bench.sh checks the real server with curl -I.)
    assert client.head("/extract").status_code == 200
    assert model.calls == 0


def test_three_concurrent_extracts_overlap_and_all_succeed(service):
    client, model = service(delay=0.4)
    statuses = []

    def call():
        statuses.append(post_extract(client).status_code)

    threads = [threading.Thread(target=call) for _ in range(3)]
    started = time.perf_counter()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    elapsed = time.perf_counter() - started
    assert statuses == [200, 200, 200]
    assert model.calls == 3
    # Serial execution would take >= 1.2 s; with INFERENCE_WORKERS >= 2 the first two overlap.
    assert elapsed < 1.1, f"extracts ran serially: {elapsed:.2f}s"


def test_health_answers_while_inference_runs(service):
    client, _ = service(delay=0.6)
    thread = threading.Thread(target=lambda: post_extract(client))
    thread.start()
    time.sleep(0.15)  # let the extract reach the model
    started = time.perf_counter()
    assert client.get("/health").status_code == 200
    health_elapsed = time.perf_counter() - started
    thread.join()
    assert health_elapsed < 0.3, f"/health blocked behind inference: {health_elapsed:.2f}s"
