const API = "http://localhost:8000/api/v1";
const FALLBACK_GEOJSON = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { id: 1, name: "Отвал «Бачатский-Западный»", zone_type: "Отвал", area_ha: 312.4, ndvi: 0.08, ndbsi: 0.71, status: "Нарушенная", year: 2021 }, geometry: { type: "Polygon", coordinates: [[[86.145, 54.292], [86.158, 54.297], [86.166, 54.287], [86.151, 54.282], [86.145, 54.292]]] } },
    { type: "Feature", properties: { id: 2, name: "Карьерный блок №2", zone_type: "Карьер", area_ha: 487.8, ndvi: 0.13, ndbsi: 0.83, status: "Нарушенная", year: 2022 }, geometry: { type: "Polygon", coordinates: [[[86.175, 54.298], [86.193, 54.303], [86.205, 54.291], [86.187, 54.284], [86.175, 54.298]]] } },
    { type: "Feature", properties: { id: 3, name: "Рекультивированный участок «Северный»", zone_type: "Рекультивация", area_ha: 156.2, ndvi: 0.36, ndbsi: 0.28, status: "Восстанавливается", year: 2024 }, geometry: { type: "Polygon", coordinates: [[[86.158, 54.275], [86.174, 54.279], [86.181, 54.268], [86.163, 54.265], [86.158, 54.275]]] } },
    { type: "Feature", properties: { id: 4, name: "Южный отвал", zone_type: "Отвал", area_ha: 224.7, ndvi: 0.19, ndbsi: 0.58, status: "Нарушенная", year: 2023 }, geometry: { type: "Polygon", coordinates: [[[86.194, 54.273], [86.211, 54.278], [86.219, 54.266], [86.201, 54.261], [86.194, 54.273]]] } }
  ]
};
const FALLBACK_STATS = { years: [2021, 2022, 2023, 2024, 2025], disturbed_ha: [1180, 1152, 1111, 1047, 982], reclaimed_ha: [42, 78, 126, 198, 274] };
const QUICK_JUMPS = {
  overview: { center: [86.5, 54.35], zoom: 8.5 },
  bachatsky: { center: [86.175, 54.283], zoom: 12.5 },
  taldinsky: { center: [87.055, 54.175], zoom: 12.5 },
  krasnobrodsky: { center: [86.44, 54.135], zoom: 12.5 },
  mezhdurechensk: { center: [88.08, 53.72], zoom: 12 }
};

let geojson = FALLBACK_GEOJSON;
let stats = FALLBACK_STATS;
let map;
let chart;
let mode = "monitoring";
let drawing = false;
let draftPoints = [];
let mapReady = false;
let selectedFeature = null;
let ndviTaskStatus = "";
let simulationFeatures = null;

const byId = (id) => document.getElementById(id);

async function loadJson(url, fallback) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn(`Используются резервные данные для ${url}`, error);
    return fallback;
  }
}

function displayData() {
  const features = simulationFeatures || geojson.features;
  return {
    ...geojson,
    features: features.map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        displayNdvi: feature.properties.predicted_ndvi ?? feature.properties.displayNdvi ?? feature.properties.ndvi
      }
    }))
  };
}

function ndviColor(value) {
  return value < 0.25 ? "#E53935" : value < 0.45 ? "#FFB300" : "#00DF81";
}

function formatNumber(value, digits = 2) {
  return Number(value || 0).toLocaleString("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function getNdviStatus(value) {
  if (value < 0.15) return "Открытый грунт / Голая порода";
  if (value < 0.25) return "Высокая степень деградации";
  if (value < 0.45) return "Начальное зарастание";
  return "Восстановленный биоценоз";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function renderPolygonLists() {
  const items = geojson.features.map((feature) => {
    const id = escapeHtml(feature.properties.id);
    const active = selectedFeature && String(selectedFeature.properties.id) === String(feature.properties.id) ? " active" : "";
    const selectButton = `<button type="button" class="${active}" data-select-id="${id}">${escapeHtml(feature.properties.name)}</button>`;
    return {
      selection: selectButton,
      monitoring: `<div class="polygon-item">${selectButton}<button type="button" class="delete-button" data-delete-id="${id}">Удалить</button></div>`
    };
  });
  byId("ndvi-polygon-list").innerHTML = items.map((item) => item.selection).join("");
  byId("monitoring-polygon-list").innerHTML = items.map((item) => item.monitoring).join("");
}

function renderSelectedFeature() {
  const container = byId("selected-info");
  if (!selectedFeature) {
    container.innerHTML = '<p class="selection-hint">Кликните по любому участку на карте, чтобы просмотреть его спектральные показатели и оценку состояния</p>';
    return;
  }
  const properties = selectedFeature.properties;
  const ndvi = Number(properties.ndvi) || 0;
  const ndbsi = Math.max(0, Math.min(1, Number(properties.ndbsi) || 0));
  container.innerHTML = `
    <div class="selection-card">
      <h3 class="selection-name">${escapeHtml(properties.name)}</h3>
      <div class="selection-meta"><span>Тип</span><b>${escapeHtml(properties.zone_type)}</b></div>
      <div class="selection-meta"><span>Площадь</span><b>${formatNumber(properties.area_ha, 1)} га</b></div>
      <div class="index-row"><span>NDVI</span><b class="index-value" style="color:${ndviColor(ndvi)}">${formatNumber(ndvi)}</b></div>
      <div class="progress"><span style="width:${Math.max(0, Math.min(1, ndvi)) * 100}%;background:${ndviColor(ndvi)}"></span></div>
      <div class="selection-meta"><span>Состояние</span><b>${getNdviStatus(ndvi)}</b></div>
      <div class="index-row"><span>NDBSI</span><b class="index-value">${formatNumber(ndbsi)}</b></div>
      <div class="progress"><span style="width:${ndbsi * 100}%;background:#D99B3F"></span></div>
      <div class="selection-actions">
        <button type="button" class="recalculate-button" id="recalculate-ndvi">Запустить пересчет NDVI (Sentinel-2)</button>
      </div>
      <p id="ndvi-task-status" class="task-status ${ndviTaskStatus.startsWith("Ошибка") ? "error" : "success"}">${escapeHtml(ndviTaskStatus)}</p>
    </div>`;
  byId("recalculate-ndvi").addEventListener("click", queueNdviTask);
}

function setSelectedFeature(feature) {
  selectedFeature = feature;
  ndviTaskStatus = "";
  renderSelectedFeature();
  renderPolygonLists();
  if (mapReady) {
    map.getSource("selected-land")?.setData({
      type: "FeatureCollection",
      features: feature ? [feature] : []
    });
  }
}

async function queueNdviTask() {
  if (!selectedFeature) return;
  const status = byId("ndvi-task-status");
  status.className = "task-status";
  status.textContent = "Постановка задачи пересчета...";
  try {
    const response = await fetch(`${API}/tasks/ndvi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bbox: turf.bbox(selectedFeature) })
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const task = await response.json();
    ndviTaskStatus = `Задача ${task.task_id}: ${task.status}`;
    renderSelectedFeature();
  } catch (error) {
    ndviTaskStatus = "Ошибка: не удалось запустить пересчет";
    status.className = "task-status error";
    status.textContent = ndviTaskStatus;
    console.error("Не удалось запустить пересчет NDVI", error);
  }
}

async function deletePolygon(polygonId) {
  const feature = geojson.features.find((item) => String(item.properties.id) === String(polygonId));
  if (!feature || !window.confirm(`Удалить участок «${feature.properties.name}»?`)) return;
  try {
    const response = await fetch(`${API}/layers/disturbed-lands/${encodeURIComponent(polygonId)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Delete failed: ${response.status}`);
  } catch (error) {
    console.warn("API недоступен, участок удалён локально", error);
  }
  geojson = { ...geojson, features: geojson.features.filter((item) => String(item.properties.id) !== String(polygonId)) };
  if (selectedFeature && String(selectedFeature.properties.id) === String(polygonId)) setSelectedFeature(null);
  simulationFeatures = null;
  updateMapData();
  updateSummary();
  renderPolygonLists();
}

function updateSummary() {
  const total = geojson.features.reduce((sum, feature) => sum + Number(feature.properties.area_ha || 0), 0);
  const mean = geojson.features.length
    ? geojson.features.reduce((sum, feature) => sum + Number(feature.properties.ndvi || 0), 0) / geojson.features.length
    : 0;
  byId("total-area").textContent = `${formatNumber(total, 1)} га`;
  byId("feature-count").textContent = geojson.features.length;
  byId("mean-ndvi").textContent = formatNumber(mean);
}

function updateMapStatus() {
  if (map) byId("map-status").textContent = `Зум ${formatNumber(map.getZoom(), 1)} · Спутник Sentinel-2 / Esri | Кузбасс`;
}

function setLayerVisibility(layerId, visible) {
  if (mapReady && map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}

function renderChart() {
  chart?.destroy();
  chart = new Chart(byId("dynamicsChart"), {
    type: "line",
    data: {
      labels: stats.years,
      datasets: [
        { label: "Нарушенные, га", data: stats.disturbed_ha, borderColor: "#03624C", backgroundColor: "#03624C18", pointBackgroundColor: "#03624C", fill: true, tension: 0.2 },
        { label: "Рекультивированные, га", data: stats.reclaimed_ha, borderColor: "#00DF81", backgroundColor: "#00DF8118", pointBackgroundColor: "#00DF81", fill: false, tension: 0.2 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { labels: { color: "#0B453A", font: { size: 10 } } } },
      scales: {
        x: { ticks: { color: "#707D7D" }, grid: { color: "#AACBC4" } },
        y: { ticks: { color: "#707D7D" }, grid: { color: "#AACBC4" } }
      }
    }
  });
}

function renderForecastChart(features, years) {
  const totalArea = features.reduce((sum, feature) => sum + Number(feature.properties.area_ha || 0), 0);
  const reclaimedArea = features
    .filter((feature) => feature.properties.predicted_ndvi >= 0.35)
    .reduce((sum, feature) => sum + Number(feature.properties.area_ha || 0), 0);
  const horizon = years.length - 1;
  const reclaimed = years.map((_, index) => reclaimedArea * (horizon ? index / horizon : 1));
  const disturbed = years.map((_, index) => totalArea - reclaimed[index]);
  chart?.destroy();
  chart = new Chart(byId("dynamicsChart"), {
    type: "line",
    data: {
      labels: years,
      datasets: [
        { label: "Нарушенные, га", data: disturbed, borderColor: "#E53935", backgroundColor: "#E5393518", pointBackgroundColor: "#E53935", fill: true, tension: 0.2 },
        { label: "Рекультивированные, га", data: reclaimed, borderColor: "#00DF81", backgroundColor: "#00DF8118", pointBackgroundColor: "#00DF81", fill: false, tension: 0.2 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { labels: { color: "#0B453A", font: { size: 10 } } } },
      scales: {
        x: { ticks: { color: "#707D7D" }, grid: { color: "#AACBC4" } },
        y: { ticks: { color: "#707D7D" }, grid: { color: "#AACBC4" } }
      }
    }
  });
}

function setMapColorExpression() {
  const property = simulationFeatures ? "predicted_ndvi" : "displayNdvi";
  const greenThreshold = simulationFeatures ? 0.4 : 0.45;
  map?.setPaintProperty("lands-fill", "fill-color", [
    "interpolate", ["linear"], ["get", property],
    -1, "#E53935", 0.25, "#E53935", greenThreshold - 0.001, "#FFB300", greenThreshold, "#00DF81", 1, "#00DF81"
  ]);
}

function updateMapData() {
  if (!mapReady) return;
  map?.getSource("lands")?.setData(displayData());
  map?.getSource("labels")?.setData(displayData());
  map?.getSource("selected-land")?.setData({
    type: "FeatureCollection",
    features: selectedFeature ? [selectedFeature] : []
  });
}

function setMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll(".tabs button").forEach((button) => button.classList.toggle("active", button.dataset.mode === nextMode));
  ["monitoring", "ndvi", "sandbox"].forEach((name) => byId(`${name}-panel`).classList.toggle("active", name === nextMode));
  if (!mapReady) return;
  if (nextMode !== "sandbox") {
    simulationFeatures = null;
    updateMapData();
    setMapColorExpression();
    renderChart();
  } else {
    recalculateSimulation();
  }
  renderSelectedFeature();
}

function recalculateSimulation() {
  const seedlings = Number(byId("seedlings").value) / 100;
  const watering = Number(byId("watering").value) / 100;
  const years = Number(byId("horizon").value);
  byId("seed-value").textContent = `${Math.round(seedlings * 100)}%`;
  byId("water-value").textContent = `${Math.round(watering * 100)}%`;
  byId("years-value").textContent = `${years} ${years === 1 ? "год" : "лет"}`;
  const growth = (seedlings * 0.45 + watering * 0.35) * (1 - Math.exp(-0.35 * years));
  simulationFeatures = geojson.features.map((feature) => ({
    ...feature,
    properties: {
      ...feature.properties,
      base_ndvi: Number(feature.properties.base_ndvi ?? feature.properties.ndvi ?? 0),
      predicted_ndvi: Math.min(
        0.85,
        Number(feature.properties.base_ndvi ?? feature.properties.ndvi ?? 0) +
          growth * (0.85 - Number(feature.properties.base_ndvi ?? feature.properties.ndvi ?? 0))
      ),
      land_category: "Нарушенные земли"
    }
  }));
  simulationFeatures.forEach((feature) => {
    if (feature.properties.predicted_ndvi >= 0.35) feature.properties.land_category = "Рекультивированные земли";
  });
  const totalArea = geojson.features.reduce((sum, feature) => sum + Number(feature.properties.area_ha || 0), 0);
  const reclaimedArea = simulationFeatures
    .filter((feature) => feature.properties.predicted_ndvi >= 0.35)
    .reduce((sum, feature) => sum + Number(feature.properties.area_ha || 0), 0);
  const mean = simulationFeatures.length
    ? simulationFeatures.reduce((sum, feature) => sum + feature.properties.predicted_ndvi, 0) / simulationFeatures.length
    : 0;
  byId("forecast-mean-ndvi").textContent = formatNumber(mean);
  byId("forecast-reclaimed-area").textContent = `${formatNumber(reclaimedArea, 1)} га`;
  byId("forecast-disturbed-area").textContent = `${formatNumber(totalArea - reclaimedArea, 1)} га`;
  if (mapReady) {
    updateMapData();
    setMapColorExpression();
  }
  renderForecastChart(simulationFeatures, Array.from({ length: years + 1 }, (_, index) => new Date().getFullYear() + index));
}

function updateDraftSources() {
  map.getSource("draft-line").setData({
    type: "FeatureCollection",
    features: draftPoints.length > 1 ? [{ type: "Feature", geometry: { type: "LineString", coordinates: draftPoints } }] : []
  });
  map.getSource("draft-points").setData({
    type: "FeatureCollection",
    features: draftPoints.map((coordinates) => ({ type: "Feature", geometry: { type: "Point", coordinates } }))
  });
}

function startDrawing() {
  drawing = true;
  draftPoints = [];
  byId("draw-button").textContent = "Завершить контур";
  byId("drawing-hint").classList.remove("hidden");
  map.doubleClickZoom.disable();
  updateDraftSources();
}

function finishDrawing() {
  if (draftPoints.length < 3) return;
  drawing = false;
  map.doubleClickZoom.enable();
  byId("drawing-hint").classList.add("hidden");
  byId("draw-button").textContent = "+ Нарисовать участок";
  byId("modal").classList.remove("hidden");
  byId("land-name").focus();
}

async function saveDrawing(event) {
  event.preventDefault();
  const polygon = turf.polygon([[...draftPoints, draftPoints[0]]]);
  const properties = {
    id: Date.now(),
    name: byId("land-name").value,
    zone_type: byId("land-type").value,
    area_ha: Number((turf.area(polygon) / 10000).toFixed(2)),
    ndvi: Number(byId("land-ndvi").value),
    base_ndvi: Number(byId("land-ndvi").value),
    ndbsi: 0,
    status: "Нарушенная",
    year: new Date().getFullYear()
  };
  geojson = { ...geojson, features: [...geojson.features, { type: "Feature", properties, geometry: polygon.geometry }] };
  try {
    const response = await fetch(`${API}/layers/disturbed-lands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geojson)
    });
    if (!response.ok) throw new Error(`Save failed: ${response.status}`);
    geojson = await response.json();
  } catch (error) {
    console.warn("API недоступен, участок сохранён локально", error);
  }
  byId("modal").classList.add("hidden");
  byId("land-form").reset();
  draftPoints = [];
  updateDraftSources();
  updateMapData();
  updateSummary();
  setMode(mode);
}

function cancelDrawing() {
  byId("modal").classList.add("hidden");
  draftPoints = [];
  updateDraftSources();
  drawing = false;
  map.doubleClickZoom.enable();
  byId("drawing-hint").classList.add("hidden");
  byId("draw-button").textContent = "+ Нарисовать участок";
}

function createMap() {
  map = new maplibregl.Map({
    container: "map",
    center: [86.175, 54.283],
    zoom: 12.5,
    style: {
      version: 8,
      glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
      sources: {
        satellite: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          attribution: "Esri World Imagery"
        },
        lands: { type: "geojson", data: displayData() },
        labels: { type: "geojson", data: displayData() },
        "draft-line": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        "draft-points": { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        "selected-land": { type: "geojson", data: { type: "FeatureCollection", features: [] } }
      },
      layers: [
        { id: "satellite", type: "raster", source: "satellite" },
        { id: "lands-fill", type: "fill", source: "lands", paint: { "fill-color": "#ffaa00", "fill-opacity": 0.28 } },
        { id: "lands-line", type: "line", source: "lands", paint: { "line-color": "#7f3700", "line-width": 2 } },
        { id: "selected-land-line", type: "line", source: "selected-land", paint: { "line-color": "#dfa400", "line-width": 3 } },
        { id: "labels", type: "symbol", source: "labels", layout: { "text-field": ["get", "name"], "text-size": 11 }, paint: { "text-color": "#021B1A", "text-halo-color": "#FFFFFF", "text-halo-width": 1 } },
        { id: "draft-line", type: "line", source: "draft-line", paint: { "line-color": "#dfa400", "line-width": 2, "line-dasharray": [2, 1] } },
        { id: "draft-points", type: "circle", source: "draft-points", paint: { "circle-radius": 5, "circle-color": "#FFFFFF", "circle-stroke-color": "#03624C", "circle-stroke-width": 2 } }
      ]
    }
  });

  map.on("error", (event) => console.error("MapLibre error", event.error || event));
  map.on("load", () => {
    mapReady = true;
    map.resize();
    updateMapData();
    setMode(mode);
    updateMapStatus();
  });
  map.on("resize", updateMapStatus);
  map.on("zoom", updateMapStatus);
  map.on("mousemove", (event) => {
    byId("coords").textContent = `Ш ${formatNumber(event.lngLat.lat, 6)} / Д ${formatNumber(event.lngLat.lng, 6)}`;
  });
  map.on("click", (event) => {
    if (drawing) {
      draftPoints.push([event.lngLat.lng, event.lngLat.lat]);
      updateDraftSources();
      return;
    }
    if (!mapReady || !map.getLayer("lands-fill")) return;
    const features = map.queryRenderedFeatures(event.point, { layers: ["lands-fill"] });
    if (features[0]) {
      const feature = geojson.features.find((item) => String(item.properties.id) === String(features[0].properties.id));
      if (!feature) return;
      setSelectedFeature(feature);
      const properties = feature.properties;
      new maplibregl.Popup()
        .setLngLat(event.lngLat)
        .setHTML(`<div class="popup-title">${escapeHtml(properties.name)}</div><div class="popup-row"><span>Тип</span><b>${escapeHtml(properties.zone_type)}</b></div><div class="popup-row"><span>Площадь</span><b>${formatNumber(properties.area_ha, 1)} га</b></div><div class="popup-row"><span>NDVI</span><b>${formatNumber(properties.ndvi)}</b></div><div class="popup-actions"><button type="button" class="delete-button" data-delete-id="${escapeHtml(properties.id)}">Удалить участок</button></div>`)
        .addTo(map);
    }
  });
  map.on("dblclick", () => {
    if (drawing) {
      draftPoints.pop();
      finishDrawing();
    }
  });
}

async function start() {
  [geojson, stats] = await Promise.all([
    loadJson(`${API}/layers/disturbed-lands`, FALLBACK_GEOJSON),
    loadJson(`${API}/stats/dynamics`, FALLBACK_STATS)
  ]);
  geojson = {
    ...geojson,
    features: geojson.features.map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        base_ndvi: Number(feature.properties.base_ndvi ?? feature.properties.ndvi ?? 0)
      }
    }))
  };
  updateSummary();
  renderPolygonLists();
  createMap();
  renderChart();
  document.querySelectorAll(".tabs button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  byId("quick-jump").addEventListener("change", (event) => {
    const target = QUICK_JUMPS[event.target.value];
    if (target) map.flyTo({ center: target.center, zoom: target.zoom, duration: 1200 });
  });
  byId("draw-button").addEventListener("click", () => drawing ? finishDrawing() : startDrawing());
  byId("land-form").addEventListener("submit", saveDrawing);
  byId("cancel-modal").addEventListener("click", cancelDrawing);
  ["seedlings", "watering", "horizon"].forEach((id) => byId(id).addEventListener("input", recalculateSimulation));
  byId("reset-simulation").addEventListener("click", () => {
    byId("seedlings").value = "0";
    byId("watering").value = "0";
    byId("horizon").value = "1";
    recalculateSimulation();
  });
  byId("satellite-toggle").addEventListener("change", (event) => setLayerVisibility("satellite", event.target.checked));
  byId("outlines-toggle").addEventListener("change", (event) => {
    setLayerVisibility("lands-fill", event.target.checked);
    setLayerVisibility("lands-line", event.target.checked);
  });
  byId("labels-toggle").addEventListener("change", (event) => setLayerVisibility("labels", event.target.checked));
  ["monitoring-polygon-list", "ndvi-polygon-list"].forEach((id) => byId(id).addEventListener("click", (event) => {
    const button = event.target.closest("[data-select-id]");
    if (!button) return;
    const feature = geojson.features.find((item) => String(item.properties.id) === button.dataset.selectId);
    if (feature) setSelectedFeature(feature);
  }));
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-id]");
    if (button) deletePolygon(button.dataset.deleteId);
  });
}

start().catch((error) => console.error("Ошибка запуска приложения", error));
