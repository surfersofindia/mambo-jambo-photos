import os
import cv2
import numpy as np
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, UploadFile, File
from pydantic import BaseModel
from insightface.app import FaceAnalysis

face_app = None

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


@app.get("/")
def root():
    return {"status": "ok", "message": "Mambo Jambo Face API is running."}


@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": face_app is not None}


@app.post("/extract", response_model=list[FaceResult])
async def extract_faces(file: UploadFile = File(...)):
    if face_app is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet. Retry in a few seconds.")
    try:
        image_bytes = await file.read()
        np_arr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(status_code=400, detail="Could not decode the uploaded image. Please use a JPG or PNG.")

        faces = face_app.get(img)

        results = []
        for face in faces:
            emb = face.embedding.tolist()
            conf = float(face.det_score)
            results.append(FaceResult(embedding=emb, confidence=conf))

        return results

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal error processing image: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 7860)))
