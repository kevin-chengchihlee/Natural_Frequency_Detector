# Natural Frequency Diagnostics PWA

Real-time FFT analyzer for detecting natural frequencies, harmonics, and sound diagnostics — runs entirely in the browser.

## Features
- 8192-point FFT with 5.4 Hz bin resolution
- Real-time spectrum, spectrogram, and waveform views
- Automatic peak detection and fundamental frequency identification
- Harmonic analysis (2×–6× fundamental)
- Capture & history with local storage persistence
- Adjustable frequency range (1k–20k Hz)
- Installable PWA — works offline after first visit

## Deploy to GitHub Pages

### Option A: Quick (GitHub UI)

1. Go to [github.com/new](https://github.com/new) and create a new repository (e.g., `freq-diag`)
2. Upload all files from this folder: `index.html`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`
3. Go to **Settings → Pages**
4. Under "Source", select **Deploy from a branch**
5. Choose `main` branch, `/ (root)` folder, click **Save**
6. Your app will be live at `https://<your-username>.github.io/freq-diag/`

### Option B: Git CLI

```bash
cd freq-diag
git init
git add .
git commit -m "Initial PWA deploy"
git branch -M main
git remote add origin https://github.com/<your-username>/freq-diag.git
git push -u origin main
```

Then enable Pages in Settings as described above.

## Usage

1. Visit the deployed URL on any device
2. Chrome/Safari will prompt "Add to Home Screen" for app-like experience
3. Tap **Start**, grant microphone permission
4. Tap/excite the structure you're measuring
5. The red marker shows the dominant natural frequency
6. Hit **Capture** to save measurements to history

## Notes
- HTTPS is required (GitHub Pages provides this automatically)
- Microphone access requires user permission
- Works on desktop Chrome/Firefox/Edge and mobile Safari/Chrome
- All processing is client-side — no data leaves your device
