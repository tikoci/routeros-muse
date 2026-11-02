#!/usr/bin/env bun
// build-map.ts — fixture site-map generator: fixtures → self-contained
// Leaflet page + KML truth. Offline by construction: Leaflet is inlined
// from vendor/, markers are pure SVG (no icon images), no tile layer in
// fixture mode, no fetch/XHR anywhere. Real deployments add tile layers
// from the site's gis block (see fixtures/gis.json).
// Usage: bun build-map.ts --fixtures <dir> --vendor <dir> --out <dir>
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) {
    console.error(`missing ${name} <dir>`);
    process.exit(2);
  }
  return process.argv[i + 1];
}
const fixturesDir = arg("--fixtures");
const vendorDir = arg("--vendor");
const outDir = arg("--out");

interface Device { device: string; label: string; lat: number; lon: number; role: string }
interface Link { from: string; to: string; budget_db: number }
interface Coverage { at: string; radius_m: number; model: string }
interface Sites { site: { id: string; label: string; bbox: number[] }; devices: Device[]; links: Link[]; coverage: Coverage[] }
interface GisLayer { kind: string; name: string; url: string; fields: string[]; source_label: string }
interface Gis { layers: GisLayer[]; cache: { dir: string; rule: string }; privacy: { rule: string } }

const sites: Sites = JSON.parse(readFileSync(join(fixturesDir, "sites.json"), "utf8"));
const gis: Gis = JSON.parse(readFileSync(join(fixturesDir, "gis.json"), "utf8"));
const leafletJs = readFileSync(join(vendorDir, "leaflet.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const leafletCss = readFileSync(join(vendorDir, "leaflet.css"), "utf8").replace(/<\/style/gi, "<\\/style");

const byDevice = new Map(sites.devices.map((d) => [d.device, d]));
for (const l of sites.links) {
  if (!byDevice.has(l.from) || !byDevice.has(l.to)) {
    console.error(`link references unknown device: ${l.from} -> ${l.to}`);
    process.exit(2);
  }
}
const revision = createHash("sha256").update(JSON.stringify(sites)).digest("hex").slice(0, 12);
const generated = new Date().toISOString();
// Link-budget colour: green >= 15 dB, amber >= 8 dB, red below.
const colorFor = (db: number): string => (db >= 15 ? "#1a7f37" : db >= 8 ? "#b25e09" : "#c0392b");
const budgetOf = (device: string): number | null => {
  const l = sites.links.find((x) => x.from === device || x.to === device);
  return l ? l.budget_db : null;
};

const devicesJs = JSON.stringify(sites.devices);
const linksJs = JSON.stringify(sites.links.map((l) => ({ ...l, color: colorFor(l.budget_db) })));
const coverageJs = JSON.stringify(sites.coverage);
const colorsJs = JSON.stringify(Object.fromEntries(sites.devices.map((d) => {
  const b = budgetOf(d.device);
  return [d.device, b === null ? "#6b7280" : colorFor(b)];
})));
const sourcesHtml = gis.layers.map((l) => `<span class="src">${l.name}: ${l.source_label}</span>`).join(" · ");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1080, initial-scale=1">
<title>${sites.site.label} — site map (fixture)</title>
<style>${leafletCss}</style>
<style>
html,body{margin:0;padding:0;height:100%;font-family:system-ui,sans-serif}
#map{position:absolute;inset:0 0 148px 0;background:#e8eef2}
#panel{position:absolute;left:0;right:0;bottom:0;height:148px;padding:10px 16px;box-sizing:border-box;background:#fff;border-top:2px solid #111}
#panel h1{font-size:20px;margin:0 0 4px}
#panel p{font-size:14px;margin:2px 0;color:#333}
#panel .warn{color:#7a4d00;font-weight:bold}
#sources{font-size:12px;color:#555}
#correction{font-size:12px;white-space:pre-wrap;background:#f4f4f4;padding:4px 8px;min-height:18px}
#fixbar{margin-top:4px}
#fixbar button{font-size:14px;margin-right:8px}
.sketch-label{background:#fff8e1;border:1px solid #7a4d00;padding:1px 6px;font-size:13px;font-weight:bold}
</style>
</head>
<body>
<div id="map" role="application" aria-label="Fixture site map"></div>
<div id="panel">
<h1>${sites.site.label} — generated site map (fixture data)</h1>
<p>Revision <code>${revision}</code> · generated <code>${generated}</code> · positions are records truth; drag a pin to propose a correction.</p>
<p id="sources">Sources: ${sourcesHtml}</p>
<pre id="correction" aria-live="polite">(no corrections yet — drag a pin)</pre>
<div id="fixbar"><button id="copybtn" type="button">Copy correction for your agent</button><button id="kmlbtn" type="button">Download corrections KML</button></div>
</div>
<script>${leafletJs}</script>
<script>
"use strict";
var DEVICES = ${devicesJs};
var LINKS = ${linksJs};
var COVERAGE = ${coverageJs};
var COLORS = ${colorsJs};
var REVISION = ${JSON.stringify(revision)};
var map = L.map("map", { attributionControl: true }).setView(
  [DEVICES[0].lat, DEVICES[0].lon], 15);
map.attributionControl.setPrefix("fixture render — no tiles (real deployments add gis-block layers)");
// --- records drawn on top ---
var markers = {};
DEVICES.forEach(function (d) {
  var m = L.circleMarker([d.lat, d.lon], {
    radius: d.role === "main" ? 12 : 9, color: "#111", weight: 2,
    fillColor: COLORS[d.device], fillOpacity: 0.9, draggable: true
  }).addTo(map);
  m.bindTooltip(d.label + " (" + d.device + ")", { permanent: true, direction: "top" });
  m.device = d.device; m.orig = [d.lat, d.lon];
  m.on("dragend", onDrag);
  markers[d.device] = m;
});
LINKS.forEach(function (l) {
  var a = markers[l.from].getLatLng(), b = markers[l.to].getLatLng();
  L.polyline([a, b], { color: l.color, weight: 4 }).addTo(map)
    .bindTooltip("link budget " + l.budget_db + " dB (clear-air)");
});
COVERAGE.forEach(function (c) {
  var m = markers[c.at].getLatLng();
  L.circle(m, { radius: c.radius_m, color: "#7a4d00", weight: 2, dashArray: "6 4", fillOpacity: 0.05 })
    .addTo(map).bindTooltip("coverage estimate — A sketch, not a survey", {
      permanent: true, direction: "bottom", className: "sketch-label" });
});
// --- Fix GPS: human → structured correction (proposed, never auto-applied) ---
var STORE_KEY = "map-reports-corrections-" + REVISION;
function loadLocal() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (e) { return {}; }
}
function saveLocal(c) { try { localStorage.setItem(STORE_KEY, JSON.stringify(c)); } catch (e) {} }
function movedMeters(a, b) { return Math.round(map.distance(a, b) * 10) / 10; }
function renderCorrections() {
  var c = loadLocal(), keys = Object.keys(c), lines = [];
  keys.forEach(function (k) {
    var e = c[k];
    lines.push("device=" + k + " original_lat=" + e.orig[0] + " original_lon=" + e.orig[1] +
      " new_lat=" + e.now[0] + " new_lon=" + e.now[1] + " moved_m=" + e.moved_m +
      " status=proposed revision=" + REVISION);
  });
  document.getElementById("correction").textContent =
    lines.length ? lines.join("\\n") : "(no corrections yet — drag a pin)";
}
function onDrag(ev) {
  var m = ev.target, now = m.getLatLng(), c = loadLocal();
  var moved = movedMeters(m.orig, [now.lat, now.lng]);
  if (moved < 1) { delete c[m.device]; } // within tolerance: clears the local edit
  else { c[m.device] = { orig: m.orig, now: [now.lat, now.lng], moved_m: moved }; }
  saveLocal(c); renderCorrections();
}
document.getElementById("copybtn").addEventListener("click", function () {
  var t = document.getElementById("correction").textContent;
  if (navigator.clipboard) { navigator.clipboard.writeText(t); }
});
document.getElementById("kmlbtn").addEventListener("click", function () {
  var c = loadLocal(), pm = Object.keys(c).map(function (k) {
    var e = c[k];
    return "<Placemark><name>" + k + " (proposed)</name><Point><coordinates>" +
      e.now[1] + "," + e.now[0] + ",0</coordinates></Point></Placemark>";
  }).join("");
  var kml = '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2">' +
    "<Document><name>corrections " + REVISION + "</name>" + pm + "</Document></kml>";
  var a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([kml], { type: "application/vnd.google-earth.kml+xml" }));
  a.download = "corrections-" + REVISION + ".kml"; a.click();
});
renderCorrections();
</script>
</body>
</html>
`;

// --- KML truth (architect-format: opens in Google Earth, round-trips) ---
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const kmlPm = sites.devices.map((d) =>
  `    <Placemark><name>${esc(d.device)}</name><description>${esc(d.label)}</description>` +
  `<Point><coordinates>${d.lon},${d.lat},0</coordinates></Point></Placemark>`).join("\n");
const kmlLinks = sites.links.map((l) => {
  const a = byDevice.get(l.from)!; const b = byDevice.get(l.to)!;
  return `    <Placemark><name>link ${esc(l.from)}-${esc(l.to)}</name>` +
    `<description>clear-air budget ${l.budget_db} dB</description><LineString><coordinates>` +
    `${a.lon},${a.lat},0 ${b.lon},${b.lat},0</coordinates></LineString></Placemark>`;
}).join("\n");
const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n` +
  `  <Document><name>${esc(sites.site.label)} (fixture, rev ${revision})</name>\n` +
  `${kmlPm}\n${kmlLinks}\n  </Document>\n</kml>\n`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "site-map.html"), html);
writeFileSync(join(outDir, "sites.kml"), kml);
console.log(JSON.stringify({ status: "ok", out: outDir, revision, devices: sites.devices.length, links: sites.links.length }));
