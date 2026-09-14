import os
import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile, File
from pydantic import BaseModel
from insightface.app import FaceAnalysis

app = FastAPI(title="Mambo Jambo Face API")

face_app = FaceAnalysis(name="buffalo_l")
face_app.prepare(ctx_id=0, det_size=(640, 640))

class FaceResult(BaseModel):
    embedding: list[float]
    confidence: float

@app.get("/")
def health_check():
    return {"status": "ok", "message": "Face API is running."}

@app.post("/extract", response_model=list[FaceResult])
async def extract_faces(file: UploadFile = File(...)):
    try:
        image_bytes = await file.read()
        np_arr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("Failed to decode image.")
            
        faces = face_app.get(img)
        
        results = []
        for face in faces:
            emb = face.embedding.tolist()
            conf = float(face.det_score)
            results.append(FaceResult(embedding=emb, confidence=conf))
            
        return results
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Internal error processing image: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 7860)))
