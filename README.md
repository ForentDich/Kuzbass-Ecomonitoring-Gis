# ЭкоМониторинг Кузбасса — веб-ГИС прототип

Прототип модуля визуализации экологического состояния нарушенных земель. Интерфейс работает на русском языке, использует спутниковую подложку Esri, MapLibre GL JS и Chart.js. При недоступном API фронтенд автоматически переключается на встроенные GeoJSON и статистику.

## Архитектура

- `backend/app/gis_core.py` — доменные интерфейсы, обработка растров NDVI, векторизация и репозиторий демонстрационных данных.
- `backend/app/main.py` — FastAPI API: слои, постановка NDVI-задачи и динамика.
- `frontend/` — статический клиент с тремя режимами: мониторинг, NDVI и песочница рекультивации.
- Docker Compose — FastAPI, Celery, Redis, PostGIS, MinIO и Nginx.

## Локальный запуск

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload --port 8000
```

Файл `frontend/index.html` можно открыть напрямую в браузере. Для корректной загрузки CDN и спутниковых тайлов нужен доступ к интернету.
