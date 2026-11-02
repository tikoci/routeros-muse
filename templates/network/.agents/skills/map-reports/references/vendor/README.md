# Vendored render assets (offline self-test)

- `leaflet.js`, `leaflet.css` — Leaflet 1.9.4, fetched 2026-10-30 from
  `https://unpkg.com/leaflet@1.9.4/dist/` (BSD-2-Clause, © Vladimir
  Agafonkin / contributors). Vendored so `test.sh` renders with zero
  page-initiated network requests.
- The fixture page uses `L.circleMarker` / `L.polyline` / `L.circle`
  only (pure SVG, no marker images) and no tile layer, so no further
  assets are needed. Real deployments add tile layers from the site's
  `gis` block (see `../fixtures/gis.json`).
