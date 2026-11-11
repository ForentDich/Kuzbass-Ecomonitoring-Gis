from __future__ import annotations

import json
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import geopandas as gpd
import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import shapes
from rasterio.mask import mask
from shapely.geometry import shape


class CRS_MismatchException(Exception):
    """Raised when raster channels use different coordinate systems."""


class InvalidGeometryException(Exception):
    """Raised when a generated geometry cannot be repaired."""


@dataclass
class RasterMetadata:
    s3_url: str
    bounds: tuple[float, float, float, float]
    mean_ndvi: float
    min_ndvi: float
    max_ndvi: float


class IRasterProcessor(ABC):
    @abstractmethod
    def read_channels(self, b4_path: str, b8_path: str) -> tuple[np.ndarray, np.ndarray]:
        raise NotImplementedError

    @abstractmethod
    def calculate_ndvi(self, b4_path: str, b8_path: str, bbox: tuple[float, float, float, float]) -> RasterMetadata:
        raise NotImplementedError


class ILandRepository(ABC):
    @abstractmethod
    def get_polygons_by_bbox(self, bbox: tuple[float, float, float, float]) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def save_disturbed_polygons(self, polygons: dict[str, Any]) -> None:
        raise NotImplementedError

    @abstractmethod
    def delete_polygon(self, polygon_id: str) -> bool:
        raise NotImplementedError


class IStorageClient(ABC):
    @abstractmethod
    def upload_geotiff(self, path: str, key: str) -> str:
        raise NotImplementedError


class MapLayer(ABC):
    def __init__(self, layer_id: str, title: str, is_visible: bool = True, opacity: float = 1.0) -> None:
        self.layer_id = layer_id
        self.title = title
        self.is_visible = is_visible
        self.opacity = opacity

    @abstractmethod
    def generate_geojson_source(self) -> dict[str, Any]:
        raise NotImplementedError


class RasterImageryLayer(MapLayer):
    def __init__(self, layer_id: str, title: str, tile_url: str, **kwargs: Any) -> None:
        super().__init__(layer_id, title, **kwargs)
        self.tile_url = tile_url

    def generate_geojson_source(self) -> dict[str, Any]:
        return {"type": "raster", "tiles": [self.tile_url], "tileSize": 256}


class VectorPolygonLayer(MapLayer):
    def __init__(self, layer_id: str, title: str, geojson: dict[str, Any], **kwargs: Any) -> None:
        super().__init__(layer_id, title, **kwargs)
        self.geojson = geojson

    def generate_geojson_source(self) -> dict[str, Any]:
        return {"type": "geojson", "data": self.geojson}

    def fetch_as_geojson(self) -> dict[str, Any]:
        return self.geojson


class BaseRasterProcessor(IRasterProcessor):
    def read_channels(self, b4_path: str, b8_path: str) -> tuple[np.ndarray, np.ndarray]:
        with rasterio.open(b4_path) as b4, rasterio.open(b8_path) as b8:
            if b4.crs != b8.crs:
                raise CRS_MismatchException("Каналы B4 и B8 имеют разные CRS")
            return b4.read(1).astype(np.float32), b8.read(1).astype(np.float32)

    def calculate_ndvi(
        self, b4_path: str, b8_path: str, bbox: tuple[float, float, float, float]
    ) -> RasterMetadata:
        with rasterio.open(b4_path) as b4, rasterio.open(b8_path) as b8:
            if b4.crs != b8.crs:
                raise CRS_MismatchException("Каналы B4 и B8 имеют разные CRS")
            transformer = Transformer.from_crs("EPSG:4326", b4.crs, always_xy=True)
            min_x, min_y = transformer.transform(bbox[0], bbox[1])
            max_x, max_y = transformer.transform(bbox[2], bbox[3])
            window_bounds = (min_x, min_y, max_x, max_y)
            b4_values: list[np.ndarray] = []
            b8_values: list[np.ndarray] = []
            output_profile = b4.profile.copy()
            for _, window in b4.block_windows(1):
                bounds = rasterio.windows.bounds(window, b4.transform)
                if bounds[2] < window_bounds[0] or bounds[0] > window_bounds[2] or bounds[3] < window_bounds[1] or bounds[1] > window_bounds[3]:
                    continue
                b4_values.append(b4.read(1, window=window).astype(np.float32))
                b8_values.append(b8.read(1, window=window).astype(np.float32))
            if not b4_values:
                raise ValueError("BBox не пересекает растровые данные")
            b4_array = np.concatenate([item.ravel() for item in b4_values])
            b8_array = np.concatenate([item.ravel() for item in b8_values])
            valid = (b4_array != -9999.0) & (b8_array != -9999.0)
            denominator = b8_array + b4_array
            valid &= denominator != 0
            ndvi = np.full(b4_array.shape, np.nan, dtype=np.float32)
            ndvi[valid] = (b8_array[valid] - b4_array[valid]) / denominator[valid]
            output_profile.update(count=1, dtype="float32", compress="lzw", nodata=-9999.0)
            with tempfile.NamedTemporaryFile(suffix=".tif", delete=False) as output:
                with rasterio.open(output.name, "w", **output_profile) as destination:
                    destination.write(np.nan_to_num(ndvi, nan=-9999.0).reshape(1, -1), 1)
            finite = ndvi[np.isfinite(ndvi)]
            return RasterMetadata(
                s3_url=f"s3://demo/ndvi/{Path(output.name).name}",
                bounds=bbox,
                mean_ndvi=float(np.mean(finite)),
                min_ndvi=float(np.min(finite)),
                max_ndvi=float(np.max(finite)),
            )

    @staticmethod
    def vectorize_disturbed_zones(
        ndvi: np.ndarray, transform: Any, source_crs: str, threshold: float = 0.15
    ) -> dict[str, Any]:
        features: list[dict[str, Any]] = []
        mask_array = ndvi < threshold
        for geometry, value in shapes(mask_array.astype(np.uint8), mask=mask_array, transform=transform):
            if not value:
                continue
            polygon = shape(geometry).buffer(0)
            if polygon.is_empty or not polygon.is_valid:
                raise InvalidGeometryException("Не удалось исправить геометрию")
            projected_area = gpd.GeoSeries([polygon], crs=source_crs).to_crs("EPSG:6933").area.iloc[0] / 10000
            if projected_area < 0.1:
                continue
            simplified = gpd.GeoSeries([polygon], crs=source_crs).to_crs("EPSG:4326").iloc[0].simplify(
                tolerance=0.0001, preserve_topology=True
            )
            features.append({"type": "Feature", "properties": {"area_ha": round(float(projected_area), 2)}, "geometry": simplified.__geo_interface__})
        return {"type": "FeatureCollection", "features": features}


DEMO_GEOJSON: dict[str, Any] = {
    "type": "FeatureCollection",
    "features": [
        {"type": "Feature", "properties": {"id": 1, "name": "Отвал «Бачатский-Западный»", "zone_type": "Отвал", "area_ha": 312.4, "ndvi": 0.08, "ndbsi": 0.71, "status": "Нарушенная", "year": 2021}, "geometry": {"type": "Polygon", "coordinates": [[[86.145, 54.292], [86.158, 54.297], [86.166, 54.287], [86.151, 54.282], [86.145, 54.292]]]}},
        {"type": "Feature", "properties": {"id": 2, "name": "Карьерный блок №2", "zone_type": "Карьер", "area_ha": 487.8, "ndvi": 0.13, "ndbsi": 0.83, "status": "Нарушенная", "year": 2022}, "geometry": {"type": "Polygon", "coordinates": [[[86.175, 54.298], [86.193, 54.303], [86.205, 54.291], [86.187, 54.284], [86.175, 54.298]]]}},
        {"type": "Feature", "properties": {"id": 3, "name": "Рекультивированный участок «Северный»", "zone_type": "Рекультивация", "area_ha": 156.2, "ndvi": 0.36, "ndbsi": 0.28, "status": "Восстанавливается", "year": 2024}, "geometry": {"type": "Polygon", "coordinates": [[[86.158, 54.275], [86.174, 54.279], [86.181, 54.268], [86.163, 54.265], [86.158, 54.275]]]}},
        {"type": "Feature", "properties": {"id": 4, "name": "Южный отвал", "zone_type": "Отвал", "area_ha": 224.7, "ndvi": 0.19, "ndbsi": 0.58, "status": "Нарушенная", "year": 2023}, "geometry": {"type": "Polygon", "coordinates": [[[86.194, 54.273], [86.211, 54.278], [86.219, 54.266], [86.201, 54.261], [86.194, 54.273]]]}}
    ],
}


class LandGeometryRepository(ILandRepository):
    def __init__(self) -> None:
        self._data = DEMO_GEOJSON

    def get_polygons_by_bbox(self, bbox: tuple[float, float, float, float]) -> dict[str, Any]:
        return self._data

    def save_disturbed_polygons(self, polygons: dict[str, Any]) -> None:
        self._data = polygons

    def delete_polygon(self, polygon_id: str) -> bool:
        original_count = len(self._data.get("features", []))
        self._data = {
            **self._data,
            "features": [
                feature
                for feature in self._data.get("features", [])
                if str(feature.get("properties", {}).get("id")) != polygon_id
            ],
        }
        return len(self._data["features"]) < original_count


class MapAnalyticsController:
    def __init__(self, raster_processor: IRasterProcessor, land_repository: ILandRepository) -> None:
        self.raster_processor = raster_processor
        self.land_repository = land_repository

    def get_disturbed_lands(self, bbox: tuple[float, float, float, float]) -> dict[str, Any]:
        return self.land_repository.get_polygons_by_bbox(bbox)
