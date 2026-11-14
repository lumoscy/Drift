// The globe: an orthographic Earth drawn on three stacked canvases.
//   base  - ocean field + land + coastlines + graticule (redrawn only when the view or data changes)
//   wind  - steering-flow particles with fading trails
//   top   - tracks, the storm itself, markers (redrawn every frame)

import { NLON, NLAT, LAND_W, LAND_H, wrapLon } from "./env.js";
import { colorOf } from "./sim.js";
import { createCloudRenderer, VIEW_R34 } from "./cloud.js";

const DEG = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const RAMPS = {
  sst: [[0, "#10204a"], [0.45, "#1c4f8f"], [0.62, "#1f8a8c"], [0.76, "#69b86b"], [0.84, "#e8cf5a"], [0.92, "#f08a3c"], [1, "#d6364a"]],
  mpi: [[0, "#0b1530"], [0.25, "#1b3a6e"], [0.5, "#2a7f8e"], [0.7, "#e2c75a"], [0.85, "#f0803c"], [1, "#e23d6d"]],
  shear: [[0, "#0d2b3a"], [0.2, "#16606a"], [0.35, "#3d8f7a"], [0.5, "#a9a15a"], [0.7, "#a8643c"], [1, "#5c2f3f"]],
  z: [[0, "#1a1440"], [0.5, "#27407c"], [0.8, "#2f7f9a"], [0.9, "#8fc27a"], [0.96, "#f0c85a"], [1, "#f2845a"]],
  gp: [[0, "#0a1a33"], [0.1, "#123a5e"], [0.3, "#1f7f86"], [0.55, "#8fcf6a"], [0.8, "#f4d35e"], [1, "#ff7b54"]],
  none: [[0, "#0a1f3d"], [1, "#0a1f3d"]]
};

const hexToRgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

function buildLut(stops) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) {
      k += 1;
    }
    const [t0, c0] = stops[k];
    const [t1, c1] = stops[k + 1];
    const f = clamp((t - t0) / (t1 - t0 || 1), 0, 1);
    const a = hexToRgb(c0);
    const b = hexToRgb(c1);
    for (let c = 0; c < 3; c += 1) {
      lut[i * 3 + c] = Math.round(a[c] + (b[c] - a[c]) * f);
    }
  }
  return lut;
}
const LUTS = Object.fromEntries(Object.entries(RAMPS).map(([k, v]) => [k, buildLut(v)]));
export const rampCss = (layer) =>
  `linear-gradient(90deg, ${RAMPS[layer].map(([t, c]) => `${c} ${Math.round(t * 100)}%`).join(", ")})`;

export function createGlobe(host, { land, coast }) {
  const mk = () => {
    const c = document.createElement("canvas");
    host.appendChild(c);
    return c;
  };
  const baseCanvas = mk();
  const windCanvas = mk();
  const topCanvas = mk();
  const base = baseCanvas.getContext("2d");
  const wind = windCanvas.getContext("2d");
  const top = topCanvas.getContext("2d");
  const raster = document.createElement("canvas");
  const rasterCtx = raster.getContext("2d");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const view = { lon: 135, lat: 18, zoom: 1 };
  let width = 0;
  let height = 0;
  let dpr = 1;
  let radius = 100;
  let cx = 0;
  let cy = 0;
  let env = null;
  let layer = "sst";
  let layerRange = [0, 1];
  let baseDirty = true;
  let interacting = false;
  let settleTimer = 0;
  let fly = null;
  let autoSpin = !reduceMotion;
  let showWind = !reduceMotion;
  const scene = { storm: null, hour: 0, season: null, day: 0, history: null, placing: false, cursor: null, infrared: false, rings: true };
  const handlers = { pick: null, hover: null, view: null };

  // ---------- projection ----------

  let sinLat0 = 0;
  let cosLat0 = 1;
  const updateTrig = () => {
    sinLat0 = Math.sin(view.lat * DEG);
    cosLat0 = Math.cos(view.lat * DEG);
  };

  // Returns [x, y, depth]; depth > 0 means the point is on the visible side.
  const project = (lat, lon) => {
    const phi = lat * DEG;
    const dl = (lon - view.lon) * DEG;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const cosDl = Math.cos(dl);
    return [
      cx + radius * cosPhi * Math.sin(dl),
      cy - radius * (cosLat0 * sinPhi - sinLat0 * cosPhi * cosDl),
      sinLat0 * sinPhi + cosLat0 * cosPhi * cosDl
    ];
  };

  const unproject = (x, y) => {
    const vx = (x - cx) / radius;
    const vy = (cy - y) / radius;
    const r2 = vx * vx + vy * vy;
    if (r2 > 1) {
      return null;
    }
    const vz = Math.sqrt(1 - r2);
    const lat = Math.asin(clamp(vy * cosLat0 + vz * sinLat0, -1, 1)) / DEG;
    const lon = wrapLon(view.lon + Math.atan2(vx, vz * cosLat0 - vy * sinLat0) / DEG);
    return { lat, lon };
  };

  // ---------- base layer ----------

  const landBytes = land.bytes;

  function drawRaster(step) {
    const size = Math.ceil((radius * 2) / step) + 2;
    if (raster.width !== size) {
      raster.width = size;
      raster.height = size;
    }
    const img = rasterCtx.createImageData(size, size);
    const data = img.data;
    const lut = LUTS[layer] || LUTS.none;
    const grid = env && layer !== "none" ? env.fields[layer] : null;
    const [lo, hi] = layerRange;
    const span = 255 / (hi - lo || 1);
    const half = size / 2;
    const rPix = radius / step;
    const lon0 = view.lon;

    for (let py = 0; py < size; py += 1) {
      const vy = (half - py - 0.5) / rPix;
      for (let px = 0; px < size; px += 1) {
        const vx = (px + 0.5 - half) / rPix;
        const r2 = vx * vx + vy * vy;
        if (r2 >= 1) {
          continue;
        }
        const vz = Math.sqrt(1 - r2);
        const lat = Math.asin(vy * cosLat0 + vz * sinLat0) / DEG;
        let lon = lon0 + Math.atan2(vx, vz * cosLat0 - vy * sinLat0) / DEG;
        lon = ((((lon + 180) % 360) + 360) % 360);
        const o = (py * size + px) * 4;

        const lx = Math.min(LAND_W - 1, (lon * (LAND_W / 360)) | 0);
        const ly = Math.min(LAND_H - 1, ((90 - lat) * (LAND_H / 180)) | 0);
        const li = ly * LAND_W + lx;
        // Soft daylight from the upper left, darker toward the limb.
        const light = 0.42 + 0.58 * Math.pow(vz, 0.55) + 0.1 * (vy - vx) * vz;
        let r;
        let g;
        let b;
        if ((landBytes[li >> 3] >> (li & 7)) & 1) {
          const al = Math.abs(lat);
          const ice = al > 62 ? clamp((al - 62) / 9, 0, 1) : 0;
          if (grid) {
            // Under a data layer the land steps back to a quiet slate.
            r = 70 + 150 * ice;
            g = 78 + 148 * ice;
            b = 92 + 142 * ice;
          } else {
            // Forest green at the equator and in the temperate belt, drier in the subtropics.
            const dry = Math.exp(-Math.pow((al - 24) / 9, 2));
            r = 74 + 92 * dry + 150 * ice;
            g = 112 + 34 * dry + 120 * ice;
            b = 70 + 34 * dry + 165 * ice;
          }
        } else if (grid) {
          const y = lat + 90;
          const j = Math.min(NLAT - 2, y | 0);
          const i = lon | 0;
          const fy = y - j;
          const fx = lon - i;
          const i1 = i + 1 === NLON ? 0 : i + 1;
          const k = j * NLON;
          const value =
            (grid[k + i] * (1 - fx) + grid[k + i1] * fx) * (1 - fy) +
            (grid[k + NLON + i] * (1 - fx) + grid[k + NLON + i1] * fx) * fy;
          const c = clamp(((value - lo) * span) | 0, 0, 255) * 3;
          r = lut[c];
          g = lut[c + 1];
          b = lut[c + 2];
        } else {
          // Natural colour: deep blue water, a little greener and brighter toward the tropics.
          const warm = Math.max(0, 1 - Math.abs(lat) / 55);
          r = 14 + 14 * warm;
          g = 58 + 44 * warm;
          b = 118 + 44 * warm;
        }
        data[o] = r * light;
        data[o + 1] = g * light;
        data[o + 2] = b * light;
        // Feather the last pixel so the limb isn't jagged.
        data[o + 3] = r2 > 0.985 ? 255 * clamp((1 - r2) / 0.015, 0, 1) : 255;
      }
    }
    rasterCtx.putImageData(img, 0, 0);
  }

  function strokeLines(ctx, lines, scale) {
    ctx.beginPath();
    for (const line of lines) {
      let pen = false;
      for (let i = 0; i < line.length; i += 2) {
        const p = project(line[i + 1] * scale, line[i] * scale);
        if (p[2] > 0.02) {
          if (pen) {
            ctx.lineTo(p[0], p[1]);
          } else {
            ctx.moveTo(p[0], p[1]);
            pen = true;
          }
        } else {
          pen = false;
        }
      }
    }
    ctx.stroke();
  }

  const graticule = [];
  for (let lon = -180; lon < 180; lon += 30) {
    const line = [];
    for (let lat = -80; lat <= 80; lat += 4) {
      line.push(lon, lat);
    }
    graticule.push(line);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const line = [];
    for (let lon = -180; lon <= 180; lon += 4) {
      line.push(lon, lat);
    }
    graticule.push(line);
  }
  const tropics = [23.44, -23.44].map((lat) => {
    const line = [];
    for (let lon = -180; lon <= 180; lon += 4) {
      line.push(lon, lat);
    }
    return line;
  });

  function drawBase() {
    updateTrig();
    base.setTransform(dpr, 0, 0, dpr, 0, 0);
    base.clearRect(0, 0, width, height);

    // Atmosphere: a soft halo outside the limb.
    const halo = base.createRadialGradient(cx, cy, radius * 0.96, cx, cy, radius * 1.16);
    halo.addColorStop(0, "rgba(60,150,255,0.45)");
    halo.addColorStop(0.35, "rgba(90,160,255,0.16)");
    halo.addColorStop(1, "rgba(120,170,255,0)");
    base.fillStyle = halo;
    base.beginPath();
    base.arc(cx, cy, radius * 1.16, 0, Math.PI * 2);
    base.fill();

    drawRaster(interacting ? 2.5 : 1);
    base.imageSmoothingEnabled = true;
    base.imageSmoothingQuality = "high";
    base.drawImage(raster, cx - radius - (interacting ? 2.5 : 1), cy - radius - (interacting ? 2.5 : 1), raster.width * (interacting ? 2.5 : 1), raster.height * (interacting ? 2.5 : 1));

    base.save();
    base.beginPath();
    base.arc(cx, cy, radius, 0, Math.PI * 2);
    base.clip();
    base.lineWidth = 0.6;
    base.strokeStyle = "rgba(190,215,255,0.09)";
    strokeLines(base, graticule, 1);
    base.setLineDash([2, 5]);
    base.strokeStyle = "rgba(255,220,150,0.16)";
    strokeLines(base, tropics, 1);
    base.setLineDash([]);
    base.lineWidth = 0.8;
    base.strokeStyle = "rgba(225,238,255,0.42)";
    strokeLines(base, coast, 0.05);
    // Inner rim light.
    const rim = base.createRadialGradient(cx, cy, radius * 0.82, cx, cy, radius);
    rim.addColorStop(0, "rgba(120,190,255,0)");
    rim.addColorStop(1, "rgba(120,190,255,0.22)");
    base.fillStyle = rim;
    base.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    base.restore();
    baseDirty = false;
  }

  // ---------- wind particles ----------

  const PARTICLES = 1500;
  const parts = new Float32Array(PARTICLES * 3);
  const spawn = (i) => {
    // Uniform over the visible disc, then mapped back onto the sphere.
    for (let tries = 0; tries < 6; tries += 1) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius * 0.995;
      const ll = unproject(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      if (ll && Math.abs(ll.lat) < 72) {
        parts[i * 3] = ll.lon;
        parts[i * 3 + 1] = ll.lat;
        parts[i * 3 + 2] = Math.random() * 90;
        return;
      }
    }
    parts[i * 3 + 2] = 999;
  };

  function resetWind() {
    wind.setTransform(1, 0, 0, 1, 0, 0);
    wind.clearRect(0, 0, windCanvas.width, windCanvas.height);
    for (let i = 0; i < PARTICLES; i += 1) {
      spawn(i);
    }
  }

  function stepWind() {
    if (!env || !showWind || interacting) {
      return;
    }
    wind.setTransform(dpr, 0, 0, dpr, 0, 0);
    wind.globalCompositeOperation = "destination-in";
    wind.fillStyle = "rgba(0,0,0,0.93)";
    wind.fillRect(0, 0, width, height);
    wind.globalCompositeOperation = "lighter";
    wind.lineWidth = 1;
    wind.lineCap = "round";
    const u = env.fields.u;
    const v = env.fields.v;
    const k = 0.045 / Math.sqrt(view.zoom);
    for (let pass = 0; pass < 2; pass += 1) {
      // Two passes so fast air (jets) can be drawn brighter without changing style per segment.
      wind.strokeStyle = pass ? "rgba(255,255,255,0.5)" : "rgba(190,225,255,0.28)";
      wind.beginPath();
      for (let i = pass; i < PARTICLES; i += 2) {
        const o = i * 3;
        if (parts[o + 2] > 110) {
          spawn(i);
          continue;
        }
        const lon = parts[o];
        const lat = parts[o + 1];
        const gi = (((lon + 180) % 360 + 360) % 360) | 0;
        const gj = clamp((lat + 90) | 0, 0, NLAT - 1);
        const uu = u[gj * NLON + gi];
        const vv = v[gj * NLON + gi];
        const a = project(lat, lon);
        const nLat = lat + vv * k;
        const nLon = lon + (uu * k) / Math.max(0.25, Math.cos(lat * DEG));
        const b = project(nLat, nLon);
        parts[o] = nLon;
        parts[o + 1] = nLat;
        parts[o + 2] += 1;
        if (a[2] < 0.05 || b[2] < 0.05 || Math.abs(nLat) > 78) {
          parts[o + 2] = 999;
          continue;
        }
        wind.moveTo(a[0], a[1]);
        wind.lineTo(b[0], b[1]);
      }
      wind.stroke();
    }
    wind.globalCompositeOperation = "source-over";
  }

  // ---------- storms ----------

  function drawTrack(points, { upto = Infinity, from = 0, width: w = 2.2, alpha = 1, stride = 2, dim = 0.28 }) {
    top.lineWidth = w;
    top.lineCap = "round";
    top.lineJoin = "round";
    let prev = null;
    let prevColour = "";
    let open = false;
    const flush = () => {
      if (open) {
        top.stroke();
        open = false;
      }
    };
    for (let i = from; i < points.length; i += stride) {
      const p = points[i];
      const xy = project(p.lat, p.lon);
      if (xy[2] <= 0.02) {
        flush();
        prev = null;
        continue;
      }
      const past = p.hour <= upto;
      const colour = colorOf(p.v) + (past ? "" : "|");
      if (prev) {
        if (colour !== prevColour || !open) {
          flush();
          top.globalAlpha = alpha * (past ? 1 : dim);
          top.strokeStyle = colorOf(p.v);
          top.beginPath();
          top.moveTo(prev[0], prev[1]);
          open = true;
          prevColour = colour;
        }
        top.lineTo(xy[0], xy[1]);
      }
      prev = xy;
    }
    flush();
    top.globalAlpha = 1;
  }

  // The storm itself: the shader's satellite picture, laid on the globe at true scale.
  const cloud = createCloudRenderer(512);

  function drawCloud(point, seed, time) {
    const xy = project(point.lat, point.lon);
    if (xy[2] <= 0.08) {
      return;
    }
    const pxPerKm = (radius * DEG) / 111.2;
    const half = Math.max(44, point.r34 * VIEW_R34 * pxPerKm);
    const squash = 0.72 + 0.28 * xy[2];
    if (cloud.ok) {
      cloud.render(point, time, { infrared: scene.infrared, seed });
      // Turn the sprite so its north follows the globe's north at this spot.
      const north = project(Math.min(89, point.lat + 1), point.lon);
      const tilt = Math.atan2(north[0] - xy[0], xy[1] - north[1]);
      top.save();
      top.translate(xy[0], xy[1]);
      top.rotate(tilt);
      top.scale(1, squash);
      top.globalAlpha = 0.97;
      top.drawImage(cloud.canvas, -half, -half, half * 2, half * 2);
      top.restore();
    } else {
      const g = top.createRadialGradient(xy[0], xy[1], 0, xy[0], xy[1], half * 0.4);
      g.addColorStop(0, "rgba(255,255,255,0.85)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      top.fillStyle = g;
      top.beginPath();
      top.arc(xy[0], xy[1], half * 0.4, 0, Math.PI * 2);
      top.fill();
    }
    if (point.v >= 17.2 && scene.rings) {
      const gale = point.r34 * pxPerKm;
      top.setLineDash([4, 5]);
      top.lineWidth = 1;
      top.strokeStyle = "rgba(255,225,90,0.9)";
      top.beginPath();
      top.ellipse(xy[0], xy[1], gale, gale * squash, 0, 0, Math.PI * 2);
      top.stroke();
      top.setLineDash([]);
    }
  }

  function marker(lat, lon, colour, label) {
    const xy = project(lat, lon);
    if (xy[2] <= 0.05) {
      return;
    }
    top.fillStyle = colour;
    top.beginPath();
    top.moveTo(xy[0], xy[1] - 7);
    top.lineTo(xy[0] + 5, xy[1] + 3);
    top.lineTo(xy[0] - 5, xy[1] + 3);
    top.closePath();
    top.fill();
    if (label) {
      top.font = "11px system-ui, sans-serif";
      top.fillStyle = "rgba(255,255,255,0.85)";
      top.fillText(label, xy[0] + 8, xy[1] + 3);
    }
  }

  function drawTop(time) {
    top.setTransform(dpr, 0, 0, dpr, 0, 0);
    top.clearRect(0, 0, width, height);
    top.save();
    top.beginPath();
    top.arc(cx, cy, radius, 0, Math.PI * 2);
    top.clip();

    if (scene.season) {
      for (const storm of scene.season) {
        const elapsed = (scene.day - storm.day) * 24;
        if (elapsed < 0) {
          continue;
        }
        const alive = elapsed <= storm.hours;
        drawTrack(storm.points, { upto: elapsed, width: alive ? 2 : 1.2, alpha: alive ? 1 : 0.62, stride: 3, dim: 0 });
        if (alive) {
          const p = storm.points[Math.min(storm.points.length - 1, Math.floor(elapsed))];
          const xy = project(p.lat, p.lon);
          if (xy[2] > 0.05) {
            const pulse = 5 + 2 * Math.sin(time * 4 + storm.day);
            top.fillStyle = "rgba(255,255,255,0.18)";
            top.beginPath();
            top.arc(xy[0], xy[1], pulse + 4, 0, Math.PI * 2);
            top.fill();
            top.fillStyle = colorOf(p.v);
            top.beginPath();
            top.arc(xy[0], xy[1], 3.4, 0, Math.PI * 2);
            top.fill();
          }
        }
      }
    }

    if (scene.history) {
      top.lineWidth = 4.5;
      top.strokeStyle = "rgba(255,255,255,0.85)";
      top.lineJoin = "round";
      top.beginPath();
      let pen = false;
      for (const p of scene.history) {
        const xy = project(p.lat, p.lon);
        if (xy[2] > 0.02) {
          if (pen) {
            top.lineTo(xy[0], xy[1]);
          } else {
            top.moveTo(xy[0], xy[1]);
            pen = true;
          }
        } else {
          pen = false;
        }
      }
      top.stroke();
      drawTrack(scene.history, { width: 2.4, stride: 1 });
    }

    if (scene.storm) {
      const storm = scene.storm;
      drawTrack(storm.points, { upto: scene.hour, width: 2.6, stride: 2 });
      for (const event of storm.events) {
        if (event.type === "landfall" && event.hour <= scene.hour) {
          marker(event.lat, event.lon, "#ffffff", "登陆");
        }
      }
      const origin = project(storm.origin.lat, storm.origin.lon);
      if (origin[2] > 0.05) {
        top.strokeStyle = "rgba(255,255,255,0.7)";
        top.lineWidth = 1.2;
        top.beginPath();
        top.arc(origin[0], origin[1], 4.5, 0, Math.PI * 2);
        top.stroke();
      }
      const p = storm.points[Math.min(storm.points.length - 1, Math.round(scene.hour))];
      drawCloud(p, storm.seed, reduceMotion ? scene.hour * 0.05 : time * 0.6 + scene.hour * 0.05);
    }
    top.restore();

    if (scene.placing && scene.cursor) {
      const { x, y } = scene.cursor;
      top.strokeStyle = "rgba(95,227,208,0.95)";
      top.lineWidth = 1.4;
      top.beginPath();
      top.arc(x, y, 12 + 2 * Math.sin(time * 5), 0, Math.PI * 2);
      top.moveTo(x - 20, y);
      top.lineTo(x - 6, y);
      top.moveTo(x + 6, y);
      top.lineTo(x + 20, y);
      top.moveTo(x, y - 20);
      top.lineTo(x, y - 6);
      top.moveTo(x, y + 6);
      top.lineTo(x, y + 20);
      top.stroke();
    }
  }

  // ---------- sizing, interaction, loop ----------

  function resize() {
    const rect = host.getBoundingClientRect();
    width = Math.max(200, rect.width);
    height = Math.max(200, rect.height);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [baseCanvas, windCanvas, topCanvas]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    layout();
  }

  function layout() {
    const pad = host.dataset.padLeft ? Number(host.dataset.padLeft) : 0;
    const padRight = host.dataset.padRight ? Number(host.dataset.padRight) : 0;
    const padBottom = host.dataset.padBottom ? Number(host.dataset.padBottom) : 0;
    const freeW = Math.max(240, width - pad - padRight);
    const freeH = Math.max(240, height - padBottom);
    radius = Math.min(freeW, freeH) * 0.45 * view.zoom;
    cx = pad + freeW / 2;
    cy = freeH / 2 + 4;
    updateTrig();
    baseDirty = true;
    resetWind();
  }

  const touch = () => {
    interacting = true;
    baseDirty = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      interacting = false;
      baseDirty = true;
      resetWind();
      handlers.view?.(view);
    }, 160);
  };

  const pointers = new Map();
  let dragMoved = 0;
  let pinchStart = null;
  topCanvas.style.touchAction = "none";
  topCanvas.addEventListener("pointerdown", (event) => {
    topCanvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragMoved = 0;
    autoSpin = false;
    fly = null;
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom };
    }
  });
  topCanvas.addEventListener("pointermove", (event) => {
    const rect = topCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    scene.cursor = { x, y };
    const prev = pointers.get(event.pointerId);
    if (!prev) {
      handlers.hover?.(unproject(x, y), x, y);
      return;
    }
    const dx = event.clientX - prev.x;
    const dy = event.clientY - prev.y;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = Array.from(pointers.values());
      view.zoom = clamp((pinchStart.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinchStart.dist, 0.7, 6);
      layout();
      touch();
      return;
    }
    dragMoved += Math.abs(dx) + Math.abs(dy);
    if (dragMoved > 4) {
      const k = 180 / Math.PI / radius;
      view.lon = wrapLon(view.lon - dx * k);
      view.lat = clamp(view.lat + dy * k, -85, 85);
      updateTrig();
      touch();
    }
  });
  const release = (event) => {
    const had = pointers.delete(event.pointerId);
    if (pointers.size < 2) {
      pinchStart = null;
    }
    if (had && dragMoved <= 4 && event.type === "pointerup") {
      const rect = topCanvas.getBoundingClientRect();
      const ll = unproject(event.clientX - rect.left, event.clientY - rect.top);
      if (ll) {
        handlers.pick?.(ll);
      }
    }
  };
  topCanvas.addEventListener("pointerup", release);
  topCanvas.addEventListener("pointercancel", release);
  topCanvas.addEventListener("pointerleave", () => {
    scene.cursor = null;
    handlers.hover?.(null);
  });
  topCanvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    autoSpin = false;
    view.zoom = clamp(view.zoom * Math.exp(-event.deltaY * 0.0014), 0.7, 6);
    layout();
    touch();
  }, { passive: false });

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (fly) {
      fly.t = Math.min(1, fly.t + dt / fly.duration);
      const e = 1 - Math.pow(1 - fly.t, 3);
      view.lon = wrapLon(fly.from.lon + fly.dLon * e);
      view.lat = fly.from.lat + (fly.to.lat - fly.from.lat) * e;
      view.zoom = fly.from.zoom + (fly.to.zoom - fly.from.zoom) * e;
      layout();
      interacting = fly.t < 1;
      if (fly.t >= 1) {
        fly = null;
        baseDirty = true;
        handlers.view?.(view);
      }
    } else if (autoSpin && !scene.storm && !scene.season) {
      view.lon = wrapLon(view.lon + dt * 2.2);
      updateTrig();
      baseDirty = true;
    }
    if (baseDirty) {
      drawBase();
      if (autoSpin) {
        wind.setTransform(1, 0, 0, 1, 0, 0);
        wind.clearRect(0, 0, windCanvas.width, windCanvas.height);
      }
    }
    if (!autoSpin) {
      stepWind();
    }
    drawTop(now / 1000);
    requestAnimationFrame(frame);
  }

  new ResizeObserver(resize).observe(host);
  resize();
  requestAnimationFrame(frame);

  return {
    view,
    scene,
    project,
    cloud,
    on(name, fn) {
      handlers[name] = fn;
    },
    setEnv(nextEnv, nextLayer, range) {
      env = nextEnv;
      layer = nextLayer;
      layerRange = range || [0, 1];
      baseDirty = true;
    },
    setWind(on) {
      showWind = on && !reduceMotion;
      resetWind();
    },
    stopSpin() {
      autoSpin = false;
    },
    flyTo(lon, lat, zoom = view.zoom, duration = 1.1) {
      autoSpin = false;
      fly = { t: 0, duration, from: { ...view }, to: { lon, lat, zoom }, dLon: wrapLon(lon - view.lon) };
    },
    relayout: layout
  };
}
