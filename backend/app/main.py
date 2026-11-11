from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .gis_core import BaseRasterProcessor, LandGeometryRepository, MapAnalyticsController

app = FastAPI(title="Kuzbass Eco Monitoring GIS", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])
controller = MapAnalyticsController(BaseRasterProcessor(), LandGeometryRepository())


@app.get("/api/v1/layers/disturbed-lands")
def disturbed_lands() -> dict[str, Any]:
    return controller.get_disturbed_lands((86.14, 54.26, 86.22, 54.30))


@app.post("/api/v1/layers/disturbed-lands")
def save_disturbed_lands(payload: dict[str, Any]) -> dict[str, Any]:
    controller.land_repository.save_disturbed_polygons(payload)
    return payload


@app.delete("/api/v1/layers/disturbed-lands/{polygon_id}")
def delete_disturbed_land(polygon_id: str) -> dict[str, Any]:
    if not controller.land_repository.delete_polygon(polygon_id):
        raise HTTPException(status_code=404, detail="Участок не найден")
    return {"id": polygon_id, "deleted": True}


@app.post("/api/v1/tasks/ndvi")
def queue_ndvi_task(payload: dict[str, Any]) -> dict[str, str]:
    if not payload.get("bbox") or len(payload["bbox"]) != 4:
        raise HTTPException(status_code=422, detail="Требуется bbox выбранного полигона")
    return {"task_id": str(uuid4()), "status": "Processing_Queued"}


@app.get("/api/v1/stats/dynamics")
def dynamics() -> dict[str, list[Any]]:
    return {
        "years": [2021, 2022, 2023, 2024, 2025],
        "disturbed_ha": [1180, 1152, 1111, 1047, 982],
        "reclaimed_ha": [42, 78, 126, 198, 274],
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
