// ── weather.js ────────────────────────────────────────────────────────────────
// Fetches and parses Open-Meteo forecasts.
// Direct port of OpenMeteoClient.cs + DailyPoint.cs logic.

const BASE_URL = "https://api.open-meteo.com/v1/forecast";
const CACHE_MINUTES = 12;

let _hourlyCache = null;   // { retrievedAt, points }
let _dailyCache  = null;   // { retrievedAt, points }
let _cacheCoords = null;   // { lat, lon } — shared by both caches

// Browser's IANA timezone string, e.g. "Europe/London", "America/New_York"
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// ── Public API ────────────────────────────────────────────────────────────────

async function getHourlyForecast() {
    if (CONFIG.latitude == null || CONFIG.longitude == null) return null;

    const now = Date.now();
    if (_hourlyCache && _cacheCoords &&
        _cacheCoords.lat === CONFIG.latitude &&
        _cacheCoords.lon === CONFIG.longitude &&
        now - _hourlyCache.retrievedAt < CACHE_MINUTES * 60 * 1000) {
        return _hourlyCache;
    }

    const url = `${BASE_URL}?latitude=${CONFIG.latitude}&longitude=${CONFIG.longitude}` +
        `&hourly=precipitation_probability,precipitation,weather_code,temperature_2m,windspeed_10m,winddirection_10m` +
        `&wind_speed_unit=mph&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=2`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Open-Meteo hourly: ${resp.status}`);
    const json = await resp.json();

    const points = parseHourly(json);
    _hourlyCache = { retrievedAt: Date.now(), points };
    _cacheCoords = { lat: CONFIG.latitude, lon: CONFIG.longitude };
    return _hourlyCache;
}

async function getDailyForecast() {
    if (CONFIG.latitude == null || CONFIG.longitude == null) return null;

    const now = Date.now();
    if (_dailyCache && _cacheCoords &&
        _cacheCoords.lat === CONFIG.latitude &&
        _cacheCoords.lon === CONFIG.longitude &&
        now - _dailyCache.retrievedAt < CACHE_MINUTES * 60 * 1000) {
        return _dailyCache;
    }

    const url = `${BASE_URL}?latitude=${CONFIG.latitude}&longitude=${CONFIG.longitude}` +
        `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
        `&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=5`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Open-Meteo daily: ${resp.status}`);
    const json = await resp.json();

    const points = parseDaily(json);
    _dailyCache  = { retrievedAt: Date.now(), points };
    _cacheCoords = { lat: CONFIG.latitude, lon: CONFIG.longitude };
    return _dailyCache;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseHourly(json) {
    const h = json.hourly;
    if (!h) return [];

    const times  = h.time                     || [];
    const probs  = h.precipitation_probability || [];
    const codes  = h.weather_code              || [];
    const temps  = h.temperature_2m            || [];
    const speeds = h.windspeed_10m             || [];
    const dirs   = h.winddirection_10m         || [];

    const points = [];
    for (let i = 0; i < times.length; i++) {
        const ts    = new Date(times[i]);
        const prob  = probs[i]  ?? 0;
        const code  = codes[i]  ?? 0;
        const temp  = temps[i]  ?? null;
        const speed = speeds[i] ?? null;
        const dir   = dirs[i]   ?? null;

        points.push({
            timestamp:     ts,
            probability:   prob,
            intensity:     mapIntensity(prob),
            condition:     mapCode(code),
            temperature:   temp,
            windSpeed:     speed,
            windDirection: dir,
        });
    }
    return points;
}

function parseDaily(json) {
    const d = json.daily;
    if (!d) return [];

    const times    = d.time                          || [];
    const codes    = d.weathercode                   || [];
    const maxTemps = d.temperature_2m_max            || [];
    const minTemps = d.temperature_2m_min            || [];
    const probs    = d.precipitation_probability_max || [];
    const sunrises = d.sunrise                       || [];
    const sunsets  = d.sunset                        || [];

    const points = [];
    for (let i = 0; i < times.length; i++) {
        const date    = new Date(times[i]);
        const code    = codes[i]    ?? 0;
        const prob    = probs[i]    ?? 0;
        const tempMax = maxTemps[i] ?? 0;
        const tempMin = minTemps[i] ?? 0;
        const sunrise = sunrises[i] ? new Date(sunrises[i]) : null;
        const sunset  = sunsets[i]  ? new Date(sunsets[i])  : null;

        const { icon, label, state } = fromCodeWithProbability(code, prob);

        points.push({
            date,
            tempMax,
            tempMin,
            precipProbability: prob,
            condition:         state,
            conditionIcon:     icon,
            conditionLabel:    label,
            sunrise,
            sunset,
            get dayName()   { return isToday(this.date) ? "Today" : this.date.toLocaleDateString('en-GB', { weekday: 'short' }); },
            get tempRange() { return `${Math.round(tempMax)}° / ${Math.round(tempMin)}°`; },
            get rainLabel() { return prob >= 5 ? `${prob}%` : "—"; },
            get rainColour(){ return prob >= 75 ? "#F87171" : prob >= 50 ? "#FB923C" : prob >= 25 ? "#FCD34D" : "#6B7280"; },
            get conditionColour() {
                switch (icon) {
                    case "☀": return "#FCD34D";
                    case "🌧": return "#60A5FA";
                    case "❄": return "#BAE6FD";
                    case "⚠": return "#F97316";
                    default:  return "#9CA3AF";
                }
            },
        });
    }
    return points;
}

// ── WMO code mapping ──────────────────────────────────────────────────────────

function mapCode(code) {
    if (code === 0 || code === 1 || code === 2)                                          return "Clear";
    if (code === 3 || code === 45 || code === 48)                                        return "Cloudy";
    if ([51,53,55,61,63,65,71,73,75,77,80,81,82,85,86].includes(code))                  return "Rain";
    if (code === 95 || code === 96 || code === 99)                                       return "Warning";
    return "Cloudy";
}

function fromCode(code) {
    if (code === 0)                              return { icon: "☀", label: "Sunny",         state: "Clear"   };
    if (code === 1 || code === 2)                return { icon: "☁", label: "Mostly clear",  state: "Clear"   };
    if (code === 3)                              return { icon: "☁", label: "Overcast",       state: "Cloudy"  };
    if (code === 45 || code === 48)              return { icon: "☁", label: "Fog",            state: "Cloudy"  };
    if (code === 51 || code === 53 || code === 55) return { icon: "🌧", label: "Drizzle",    state: "Rain"    };
    if (code === 61 || code === 63 || code === 65) return { icon: "🌧", label: "Rain",        state: "Rain"    };
    if ([71,73,75,77].includes(code))            return { icon: "❄", label: "Snow",           state: "Rain"    };
    if (code === 80 || code === 81 || code === 82) return { icon: "🌧", label: "Showers",     state: "Rain"    };
    if (code === 85 || code === 86)              return { icon: "❄", label: "Snow showers",   state: "Rain"    };
    if (code === 95 || code === 96 || code === 99) return { icon: "⚠", label: "Thunderstorm", state: "Warning" };
    return { icon: "☁", label: "Cloudy", state: "Cloudy" };
}

function fromCodeWithProbability(code, prob) {
    const base = fromCode(code);
    if (base.state === "Clear" || base.state === "Cloudy") return base;
    if (base.state === "Warning") return base;
    if (prob < 25) return { icon: "☁", label: "Mostly dry",  state: "Cloudy" };
    if (prob < 50) {
        const hedged = {
            "Drizzle":      "Possible drizzle",
            "Rain":         "Chance of rain",
            "Showers":      "Chance of showers",
            "Snow":         "Possible snow",
            "Snow showers": "Possible snow",
        }[base.label] ?? `Possible ${base.label.toLowerCase()}`;
        return { icon: base.icon, label: hedged, state: base.state };
    }
    return base;
}

function mapIntensity(pct) {
    if (pct < 20) return "Light";
    if (pct < 50) return "Moderate";
    if (pct < 75) return "Heavy";
    return "Very heavy";
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function isToday(date) {
    const t = new Date();
    return date.getFullYear() === t.getFullYear() &&
           date.getMonth()    === t.getMonth()    &&
           date.getDate()     === t.getDate();
}

function cardinalDirection(deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d < 23 || d >= 338) return "N";
    if (d < 68)  return "NE";
    if (d < 113) return "E";
    if (d < 158) return "SE";
    if (d < 203) return "S";
    if (d < 248) return "SW";
    if (d < 293) return "W";
    return "NW";
}

function windLabel(speed, dir) {
    if (speed == null) return "";
    const s = `${Math.round(speed)} mph`;
    return dir != null ? `${cardinalDirection(dir)} ${s}` : s;
}
