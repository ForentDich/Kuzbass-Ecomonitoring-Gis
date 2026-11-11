import os

from celery import Celery

celery_app = Celery(
    "kuzbass_ecomonitoring",
    broker=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
    backend=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
)


@celery_app.task(name="calculate_ndvi")
def calculate_ndvi_task(payload: dict) -> dict:
    """Demo task contract; raster processing is delegated to the domain service."""
    return {"status": "Processing_Queued", "payload": payload}
