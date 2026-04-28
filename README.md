# Get The Washing In — Web App

Mobile-friendly weather companion. Same data sources as the desktop app — Open-Meteo for forecasts, RainViewer for radar. No server, no API keys, no running costs.

## Setup

**1. Edit your location**

Open `config.js` and set your coordinates:
```js
const CONFIG = {
    latitude:     51.8333,
    longitude:   -0.2833,
    locationName: "Hertfordshire, UK",
};
```
Find lat/lon by right-clicking your location on Google Maps → "What's here?"

**2. Deploy to GitHub Pages (free)**

```bash
# One-time setup
git init
git remote add origin https://github.com/YOUR_USERNAME/washing-weather.git

# Every time you update
git add .
git commit -m "update"
git push origin main
```

Then in GitHub: Settings → Pages → Source: `main` branch → Save.

Your app will be live at: `https://YOUR_USERNAME.github.io/washing-weather/web/`

**Alternatively: Cloudflare Pages**
- Connect your GitHub repo at pages.cloudflare.com
- Build command: (none)
- Output directory: `web`
- Gives you a free custom domain option

## Files

| File | Purpose |
|------|---------|
| `config.js` | Your location (edit this) |
| `weather.js` | Open-Meteo API + WMO code mapping |
| `forecast.js` | Dot/block/label logic |
| `radar.js` | RainViewer tile compositing |
| `style.css` | Dark theme, mobile-first |
| `index.html` | UI + rendering |

## Local testing

Just open `index.html` in a browser — no build step needed. CORS note: Open-Meteo and RainViewer work from `file://` in most browsers. If the map base tiles fail locally, they'll load fine once hosted on a proper domain.
