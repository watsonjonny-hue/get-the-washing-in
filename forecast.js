// ── forecast.js ───────────────────────────────────────────────────────────────
// Assembles the forecast model from raw weather + radar data.
// Port of ForecastEngine.Build() and related helpers.

const STALE_MINUTES = 30;

function buildForecast(hourlyResult, dailyResult, radarResult) {
    const model = {
        updatedAt:            new Date(),
        isDataStale:          false,
        currentProbability:   0,
        currentIntensity:     "Checking…",
        currentTemperature:   null,
        currentWindSpeed:     null,
        currentWindDirection: null,
        weatherState:         "Clear",
        nextRainLabel:        "",
        isRainingNow:         false,
        clearsSoon:           false,
        weatherDots:          [],
        blocks:               [],
        dailyForecasts:       [],
        // Radar
        imminentRainEtaMinutes: null,
        radarLabel:           "Loading…",
        radarFrames:          [],
        // Computed
        get probabilityLabel()  { return `${Math.round(this.currentProbability)}%`; },
        get temperatureLabel()  { return this.currentTemperature != null ? `${Math.round(this.currentTemperature)}°C` : ""; },
        get windLabel()         { return windLabel(this.currentWindSpeed, this.currentWindDirection); },
        get updatedAtLabel()    {
            const t = this.updatedAt;
            const hh = String(t.getHours()).padStart(2, "0");
            const mm = String(t.getMinutes()).padStart(2, "0");
            return this.isDataStale ? `${hh}:${mm} · offline` : `${hh}:${mm}`;
        },
        get updatedAtColour()   { return this.isDataStale ? "#FB923C" : "#6B7280"; },
    };

    // Stale check
    if (!hourlyResult || (Date.now() - hourlyResult.retrievedAt) > STALE_MINUTES * 60 * 1000) {
        model.isDataStale = true;
    }

    // Sunrise/sunset from today's daily point
    let sunriseHour = 6, sunsetHour = 20;
    if (dailyResult) {
        const today = dailyResult.points.find(p => isToday(p.date));
        if (today?.sunrise) sunriseHour = today.sunrise.getHours();
        if (today?.sunset)  sunsetHour  = today.sunset.getHours();
    }

    // Hourly forecast
    if (hourlyResult && hourlyResult.points.length > 0) {
        const now    = new Date();
        const future = hourlyResult.points
            .filter(p => p.timestamp >= now)
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(0, 12);

        if (future.length > 0) {
            const current = future[0];
            model.currentProbability   = current.probability;
            model.currentIntensity     = current.intensity;
            model.weatherState         = current.condition;
            model.currentTemperature   = current.temperature;
            model.currentWindSpeed     = current.windSpeed;
            model.currentWindDirection = current.windDirection;
            model.nextRainLabel        = computeNextRainLabel(future);

            // IsRainingNow / ClearsSoon
            model.isRainingNow = future[0].probability >= 50;
            if (model.isRainingNow) {
                for (let i = 1; i < future.length; i++) {
                    if (future[i].probability < 25) {
                        const hoursUntilClear = (future[i].timestamp - now) / 3600000;
                        model.clearsSoon = hoursUntilClear < 1.5;
                        break;
                    }
                }
            }

            // Weather dots — one per 2-hour block
            for (let i = 0; i < future.length; i += 2) {
                const pair  = future.slice(i, i + 2);
                const prob  = Math.max(...pair.map(p => p.probability));
                const state = pair.reduce((best, p) =>
                    p.probability > best.probability ? p : best, pair[0]).condition;

                const h0      = pair[0].timestamp.getHours();
                const night   = isNightHour(h0, sunriseHour, sunsetHour);
                const showDrop = prob >= 40;
                const dropOpacity = showDrop ? 0.25 + 0.75 * (prob / 100) : 1.0;
                const displayState = showDrop ? "Rain" : state;
                const color = dotColor(displayState, night);

                const fmt = t => `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}`;
                const label = fmt(pair[0].timestamp) + (pair.length > 1 ? `–${fmt(pair[pair.length-1].timestamp)}` : "");

                model.weatherDots.push({ color, label, state, dropOpacity, showDrop });
            }

            // 2-hour forecast blocks
            for (let i = 0; i < future.length; i += 2) {
                const pair  = future.slice(i, i + 2);
                if (!pair.length) break;
                const prob  = Math.max(...pair.map(p => p.probability));
                const state = pair.reduce((best, p) =>
                    p.probability > best.probability ? p : best, pair[0]).condition;
                const inten = pair.reduce((best, p) =>
                    rankIntensity(p.intensity) > rankIntensity(best.intensity) ? p : best, pair[0]).intensity;

                const fmt = t => `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}`;
                const endTs = new Date(pair[pair.length-1].timestamp.getTime() + 3600000);
                model.blocks.push({
                    timeRange:   `${fmt(pair[0].timestamp)}–${fmt(endTs)}`,
                    probability: prob,
                    intensity:   inten,
                    icon:        iconForState(state),
                    state,
                });
            }
        }
    }

    // Daily forecasts
    if (dailyResult) {
        model.dailyForecasts = dailyResult.points;
    }

    // Radar
    if (radarResult) {
        model.imminentRainEtaMinutes = radarResult.etaMinutes;
        model.radarFrames            = radarResult.frameDataUrls;

        // Only show "Rain here now" if the weather API also agrees (≥ 30%).
        // Radar alone is too noisy — this prevents false positives on clear days.
        if (radarResult.etaMinutes === 0 && model.currentProbability < 30) {
            model.radarLabel = "Clear on radar";
        } else {
            model.radarLabel = radarResult.summary;
        }

        if (radarResult.lastIntensity > 0.25 && model.currentProbability >= 30)
            model.currentIntensity = "Rain moving in";

        if (radarResult.etaMinutes != null) {
            if (radarResult.etaMinutes > 0)
                model.nextRainLabel = `Rain in ~${radarResult.etaMinutes} min (radar)`;
            else if (model.currentProbability >= 30)
                model.nextRainLabel = "Rain here now";
        }
    }

    // "Get the washing in!" threshold
    if (model.imminentRainEtaMinutes != null &&
        model.imminentRainEtaMinutes >= 0 &&
        model.imminentRainEtaMinutes <= 20 &&
        model.currentProbability >= 25) {
        model.nextRainLabel = "Get the washing in!";
    }

    return model;
}

// ── Next rain label (port of ComputeNextRainLabel) ────────────────────────────

function computeNextRainLabel(future) {
    if (!future.length) return "No data";

    const now = new Date();
    const fmt = t => `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}`;

    if (future[0].probability >= 50) {
        for (let i = 1; i < future.length; i++) {
            if (future[i].probability < 25) {
                const h = (future[i].timestamp - now) / 3600000;
                return h < 1.5
                    ? `Clears ~${fmt(future[i].timestamp)}`
                    : `Clears ~${fmt(future[i].timestamp)} (${Math.floor(h)} h)`;
            }
        }
        return "Rain for 12+ h";
    }

    for (let i = 1; i < future.length; i++) {
        if (future[i].probability >= 40) {
            const h = (future[i].timestamp - now) / 3600000;
            return h < 1.5
                ? `Rain likely ~${fmt(future[i].timestamp)}`
                : `Rain possible ${fmt(future[i].timestamp)} (${Math.floor(h)} h)`;
        }
    }

    const dryH = (future[future.length - 1].timestamp - now) / 3600000;
    return dryH >= 2 ? `Dry for ~${Math.floor(dryH)} h` : "No rain expected";
}

// ── Colour / icon helpers (port of WeatherDot.ColorForState) ──────────────────

function isNightHour(hour, sunriseHour, sunsetHour) {
    return hour < sunriseHour || hour >= sunsetHour;
}

function dotColor(state, night) {
    switch (state) {
        case "Clear":   return night ? "#0F2EA8" : "#FCD34D";
        case "Cloudy":  return night ? "#4B5568" : "#9CA3AF";
        case "Rain":    return night ? "#2D5FA0" : "#4A7FC4";
        case "Warning": return "#F97316";
        default:        return "#9CA3AF";
    }
}

function iconForState(state) {
    switch (state) {
        case "Clear":   return "☀";
        case "Cloudy":  return "☁";
        case "Rain":    return "🌧";
        case "Warning": return "⚠";
        default:        return "☁";
    }
}

function rankIntensity(s) {
    return { "Very heavy": 4, "Heavy": 3, "Moderate": 2, "Light": 1 }[s] ?? 0;
}
