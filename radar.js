// ── radar.js ──────────────────────────────────────────────────────────────────
// Fetches RainViewer radar frames and composites them onto a <canvas>.
// Port of RadarClient.cs — GDI+ replaced with HTML5 Canvas API.

const RADAR_ZOOM  = 7;
const TILE_SIZE   = 256;
const RADAR_HALF  = 1;      // 3×3 tile grid
const RADAR_COLOR = 4;      // TWC palette (matches desktop night theme)

// ── Public API ────────────────────────────────────────────────────────────────

async function getRadar() {
    const meta = await fetchMetadata();
    if (!meta) return { etaMinutes: null, lastIntensity: 0, summary: "Radar unavailable", frameDataUrls: [] };

    const frames = meta.slice(-6);   // last 6 frames (30 min of history)
    const { cx, cy } = locationToTile(CONFIG.latitude, CONFIG.longitude, RADAR_ZOOM);

    const intensities = [];
    const frameDataUrls = [];

    for (let fi = 0; fi < frames.length; fi++) {
        const { dataUrl, intensity } = await buildFrame(frames[fi], cx, cy, fi, frames.length);
        if (dataUrl) frameDataUrls.push(dataUrl);
        if (intensity != null) intensities.push(intensity);
    }

    const latest = intensities.length ? intensities[intensities.length - 1] : 0;
    const { etaMinutes, summary } = computeEta(intensities, latest);

    return { etaMinutes, lastIntensity: latest, summary, frameDataUrls };
}

// ── Metadata ──────────────────────────────────────────────────────────────────

async function fetchMetadata() {
    try {
        const resp = await fetch("https://api.rainviewer.com/public/weather-maps.json");
        if (!resp.ok) return null;
        const json = await resp.json();
        const frames = [];
        const radar = json.radar;
        if (!radar) return null;
        for (const section of Object.values(radar)) {
            if (!Array.isArray(section)) continue;
            for (const f of section) {
                if (f.time && f.path) frames.push({ time: f.time, path: f.path });
            }
        }
        return frames.sort((a, b) => a.time - b.time);
    } catch { return null; }
}

// ── Frame compositing ─────────────────────────────────────────────────────────

async function buildFrame(frame, cx, cy, frameIndex, totalFrames) {
    const gridW = (2 * RADAR_HALF + 1) * TILE_SIZE;
    const gridH = (2 * RADAR_HALF + 1) * TILE_SIZE;

    const canvas = document.createElement("canvas");
    canvas.width  = gridW;
    canvas.height = gridH;
    const ctx = canvas.getContext("2d");

    // Dark background (matches desktop app)
    ctx.fillStyle = "#11102A";
    ctx.fillRect(0, 0, gridW, gridH);

    // Layer 1: base map tiles
    for (let dy = -RADAR_HALF; dy <= RADAR_HALF; dy++) {
        for (let dx = -RADAR_HALF; dx <= RADAR_HALF; dx++) {
            const img = await fetchMapTile(cx + dx, cy + dy);
            if (img) ctx.drawImage(img, (dx + RADAR_HALF) * TILE_SIZE, (dy + RADAR_HALF) * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        }
    }

    // Layer 2: radar tiles (75% opacity, matching desktop's 0.75 alpha)
    let centerIntensity = null;
    for (let dy = -RADAR_HALF; dy <= RADAR_HALF; dy++) {
        for (let dx = -RADAR_HALF; dx <= RADAR_HALF; dx++) {
            const img = await fetchRadarTile(cx + dx, cy + dy, frame);
            if (!img) continue;

            if (dx === 0 && dy === 0)
                centerIntensity = measureIntensity(img);

            ctx.globalAlpha = 0.75;
            ctx.drawImage(img, (dx + RADAR_HALF) * TILE_SIZE, (dy + RADAR_HALF) * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            ctx.globalAlpha = 1.0;
        }
    }

    // Layer 3: exact sub-tile crosshair
    const latRad = CONFIG.latitude * Math.PI / 180;
    const n      = 1 << RADAR_ZOOM;
    const exactTX = (CONFIG.longitude + 180) / 360 * n;
    const exactTY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    const fracX   = exactTX - Math.floor(exactTX);
    const fracY   = exactTY - Math.floor(exactTY);

    const locPx = Math.round(RADAR_HALF * TILE_SIZE + fracX * TILE_SIZE);
    const locPy = Math.round(RADAR_HALF * TILE_SIZE + fracY * TILE_SIZE);

    ctx.strokeStyle = "rgba(167,139,250,0.8)";
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(locPx - 10, locPy); ctx.lineTo(locPx + 10, locPy);
    ctx.moveTo(locPx, locPy - 10); ctx.lineTo(locPx, locPy + 10);
    ctx.stroke();
    ctx.fillStyle = "rgba(167,139,250,0.9)";
    ctx.beginPath();
    ctx.arc(locPx, locPy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Crop centred on location
    const CROP_W = 320, CROP_H = 220;
    const cropX = Math.max(0, Math.min(locPx - CROP_W / 2, gridW - CROP_W));
    const cropY = Math.max(0, Math.min(locPy - CROP_H / 2, gridH - CROP_H));

    const cropped = document.createElement("canvas");
    cropped.width  = CROP_W;
    cropped.height = CROP_H;
    const cctx = cropped.getContext("2d");
    cctx.drawImage(canvas, cropX, cropY, CROP_W, CROP_H, 0, 0, CROP_W, CROP_H);

    // Frame progress dots (top-right)
    drawFrameDots(cctx, frameIndex, totalFrames, CROP_W);

    return { dataUrl: cropped.toDataURL(), intensity: centerIntensity };
}

function drawFrameDots(ctx, frameIndex, totalFrames, width) {
    const dotR   = 2.5;
    const gap    = 7;
    const startX = width - (totalFrames * gap) - 6;
    const y      = 8;

    for (let i = 0; i < totalFrames; i++) {
        ctx.beginPath();
        ctx.arc(startX + i * gap, y, dotR, 0, Math.PI * 2);
        ctx.fillStyle = i === frameIndex
            ? "rgba(167,139,250,0.95)"
            : "rgba(167,139,250,0.25)";
        ctx.fill();
    }
}

// ── Tile fetchers ─────────────────────────────────────────────────────────────

async function fetchMapTile(x, y) {
    // OpenFreeMap — no key required, CORS open, dark style
    const url = `https://tiles.openfreemap.org/styles/dark/${RADAR_ZOOM}/${x}/${y}.png`;
    return loadImage(url).catch(() => {
        // Fallback: plain OpenStreetMap (light, but always works)
        return loadImage(`https://tile.openstreetmap.org/${RADAR_ZOOM}/${x}/${y}.png`).catch(() => null);
    });
}

async function fetchRadarTile(x, y, frame) {
    const url = `https://tilecache.rainviewer.com${frame.path}/${TILE_SIZE}/${RADAR_ZOOM}/${x}/${y}/${RADAR_COLOR}/1_1.png`;
    return loadImage(url).catch(() => null);
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload  = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed: ${url}`));
        img.src = url;
    });
}

// ── Intensity sampling (port of MeasureIntensity) ─────────────────────────────

function measureIntensity(img) {
    const c   = document.createElement("canvas");
    c.width   = img.width || TILE_SIZE;
    c.height  = img.height || TILE_SIZE;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let total = 0, count = 0;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 10) {          // skip nearly-transparent pixels
            total += data[i] / 255;
            count++;
        }
    }
    return count > 0 ? total / count : 0;
}

// ── ETA calculation (port of ComputeEta) ─────────────────────────────────────

function computeEta(intensities, latest) {
    if (!intensities.length) return { etaMinutes: null, summary: "No radar data" };

    const NOISE = 0.30;

    if (latest >= NOISE) {
        return { etaMinutes: 0, summary: "Rain here now" };
    }

    // Look for approaching rain in recent frames (each frame = 5 min apart)
    for (let i = intensities.length - 2; i >= 0; i--) {
        if (intensities[i] >= NOISE) {
            const framesAway = intensities.length - 1 - i;
            const mins       = framesAway * 5;
            if (mins <= 60) {
                return {
                    etaMinutes: mins,
                    summary: `Rain in ~${mins} min`
                };
            }
        }
    }

    // Simple trend: if intensity is rising toward the threshold
    if (intensities.length >= 3) {
        const last3 = intensities.slice(-3);
        const rising = last3[1] > last3[0] && last3[2] > last3[1];
        if (rising && latest > 0.05) {
            const slope = (last3[2] - last3[0]) / (2 * 5);  // per minute
            const minsToThreshold = (NOISE - latest) / slope;
            if (minsToThreshold > 0 && minsToThreshold <= 60) {
                return {
                    etaMinutes: Math.round(minsToThreshold),
                    summary: `Rain approaching`
                };
            }
        }
    }

    return { etaMinutes: null, summary: "Clear on radar" };
}

// ── Tile coordinate maths (port of LocationToTile) ────────────────────────────

function locationToTile(lat, lon, zoom) {
    const latRad = lat * Math.PI / 180;
    const n      = 1 << zoom;
    return {
        cx: Math.floor((lon + 180) / 360 * n),
        cy: Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n),
    };
}
