import { useState, useRef, useCallback, useEffect } from "react";

const FFT_SIZE = 8192;
const SAMPLE_RATE = 44100;
const SMOOTHING = 0.8;
const PEAK_THRESHOLD_DB = -60;
const MIN_PEAK_DISTANCE_HZ = 20;

function hzToNote(hz) {
  if (hz <= 0) return "";
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const semitones = 12 * Math.log2(hz / 440);
  const noteIndex = Math.round(semitones) + 69;
  const octave = Math.floor(noteIndex / 12) - 1;
  const name = noteNames[((noteIndex % 12) + 12) % 12];
  const cents = Math.round((semitones - Math.round(semitones)) * 100);
  return `${name}${octave} ${cents >= 0 ? "+" : ""}${cents}¢`;
}

function detectPeaks(freqData, binWidth) {
  const peaks = [];
  for (let i = 2; i < freqData.length - 2; i++) {
    const val = freqData[i];
    if (val < PEAK_THRESHOLD_DB) continue;
    if (
      val > freqData[i - 1] &&
      val > freqData[i + 1] &&
      val > freqData[i - 2] &&
      val > freqData[i + 2]
    ) {
      const freq = i * binWidth;
      if (freq < 20 || freq > 20000) continue;
      if (peaks.length > 0) {
        const lastPeak = peaks[peaks.length - 1];
        if (freq - lastPeak.freq < MIN_PEAK_DISTANCE_HZ) {
          if (val > lastPeak.magnitude) {
            peaks[peaks.length - 1] = { freq, magnitude: val, bin: i };
          }
          continue;
        }
      }
      peaks.push({ freq, magnitude: val, bin: i });
    }
  }
  peaks.sort((a, b) => b.magnitude - a.magnitude);
  return peaks.slice(0, 8);
}

function formatFreq(hz) {
  return hz >= 1000 ? (hz / 1000).toFixed(2) + " kHz" : hz.toFixed(1) + " Hz";
}

export default function SoundDiagnostics() {
  const [isRunning, setIsRunning] = useState(false);
  const [peaks, setPeaks] = useState([]);
  const [fundamentalFreq, setFundamentalFreq] = useState(null);
  const [history, setHistory] = useState([]);
  const [viewMode, setViewMode] = useState("spectrum"); // spectrum | spectrogram | waveform
  const [maxFreqDisplay, setMaxFreqDisplay] = useState(4000);
  const [showHistory, setShowHistory] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [rmsLevel, setRmsLevel] = useState(-100);

  const canvasRef = useRef(null);
  const spectrogramCanvasRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const animFrameRef = useRef(null);
  const spectrogramColRef = useRef(0);

  const startAudio = useCallback(async () => {
    try {
      setErrorMsg(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: SAMPLE_RATE,
        },
      });
      streamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SAMPLE_RATE,
      });
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING;
      analyserRef.current = analyser;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      sourceRef.current = source;
      setIsRunning(true);

      // clear spectrogram
      spectrogramColRef.current = 0;
      const sgCanvas = spectrogramCanvasRef.current;
      if (sgCanvas) {
        const sgCtx = sgCanvas.getContext("2d");
        sgCtx.fillStyle = "#0a0a0f";
        sgCtx.fillRect(0, 0, sgCanvas.width, sgCanvas.height);
      }
    } catch (err) {
      setErrorMsg("Microphone access denied. Please allow mic permissions.");
    }
  }, []);

  const stopAudio = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (sourceRef.current) sourceRef.current.disconnect();
    if (audioCtxRef.current) audioCtxRef.current.close();
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    setIsRunning(false);
  }, []);

  const captureSnapshot = useCallback(() => {
    if (!fundamentalFreq) return;
    const entry = {
      id: Date.now(),
      timestamp: new Date().toLocaleString(),
      fundamental: fundamentalFreq,
      peaks: peaks.slice(0, 5),
      rms: rmsLevel,
    };
    setHistory((prev) => [entry, ...prev].slice(0, 50));
  }, [fundamentalFreq, peaks, rmsLevel]);

  // Animation loop
  useEffect(() => {
    if (!isRunning || !analyserRef.current) return;
    const analyser = analyserRef.current;
    const bufLen = analyser.frequencyBinCount;
    const freqData = new Float32Array(bufLen);
    const timeData = new Float32Array(analyser.fftSize);
    const binWidth = SAMPLE_RATE / analyser.fftSize;

    const draw = () => {
      animFrameRef.current = requestAnimationFrame(draw);
      analyser.getFloatFrequencyData(freqData);
      analyser.getFloatTimeDomainData(timeData);

      // RMS
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
      const rms = 20 * Math.log10(Math.sqrt(sum / timeData.length) + 1e-10);
      setRmsLevel(rms);

      // Peaks
      const detectedPeaks = detectPeaks(freqData, binWidth);
      setPeaks(detectedPeaks);
      if (detectedPeaks.length > 0) {
        setFundamentalFreq(detectedPeaks[0].freq);
      }

      // Spectrum / Waveform drawing
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const W = canvas.width;
      const H = canvas.height;

      ctx.fillStyle = "#0a0a0f";
      ctx.fillRect(0, 0, W, H);

      if (viewMode === "spectrum" || viewMode === "spectrogram") {
        // Draw spectrum
        const maxBin = Math.min(
          Math.ceil(maxFreqDisplay / binWidth),
          bufLen
        );

        // Grid lines
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 1;
        for (let db = -100; db <= 0; db += 10) {
          const y = H - ((db + 100) / 100) * H;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(W, y);
          ctx.stroke();
        }

        // Freq grid
        const freqSteps =
          maxFreqDisplay <= 2000
            ? 200
            : maxFreqDisplay <= 5000
            ? 500
            : maxFreqDisplay <= 10000
            ? 1000
            : 2000;
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.font = "10px 'JetBrains Mono', monospace";
        for (let f = freqSteps; f < maxFreqDisplay; f += freqSteps) {
          const x = (f / maxFreqDisplay) * W;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, H);
          ctx.stroke();
          ctx.fillText(f >= 1000 ? (f / 1000) + "k" : f + "", x + 2, H - 4);
        }

        // dB labels
        for (let db = -90; db <= -10; db += 10) {
          const y = H - ((db + 100) / 100) * H;
          ctx.fillText(db + "dB", 2, y - 2);
        }

        // Spectrum fill
        const gradient = ctx.createLinearGradient(0, H, 0, 0);
        gradient.addColorStop(0, "rgba(0,240,200,0.02)");
        gradient.addColorStop(0.4, "rgba(0,240,200,0.08)");
        gradient.addColorStop(0.7, "rgba(0,200,255,0.15)");
        gradient.addColorStop(1, "rgba(180,100,255,0.2)");

        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let i = 0; i < maxBin; i++) {
          const x = (i / maxBin) * W;
          const val = Math.max(freqData[i], -100);
          const y = H - ((val + 100) / 100) * H;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(W, H);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Spectrum line
        ctx.beginPath();
        for (let i = 0; i < maxBin; i++) {
          const x = (i / maxBin) * W;
          const val = Math.max(freqData[i], -100);
          const y = H - ((val + 100) / 100) * H;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "rgba(0,230,200,0.85)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Peak markers
        detectedPeaks.slice(0, 5).forEach((p, idx) => {
          const x = (p.freq / maxFreqDisplay) * W;
          const y = H - ((p.magnitude + 100) / 100) * H;
          if (x < 0 || x > W) return;

          ctx.beginPath();
          ctx.arc(x, y, idx === 0 ? 6 : 4, 0, Math.PI * 2);
          ctx.fillStyle =
            idx === 0
              ? "rgba(255,80,120,0.9)"
              : "rgba(255,180,60,0.7)";
          ctx.fill();
          ctx.strokeStyle = idx === 0 ? "#ff5078" : "#ffb43c";
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.fillStyle = "#fff";
          ctx.font = `bold ${idx === 0 ? 12 : 10}px 'JetBrains Mono', monospace`;
          const label = formatFreq(p.freq);
          const textX = Math.min(x + 8, W - 70);
          ctx.fillText(label, textX, y - 8);
          if (idx === 0) {
            ctx.fillStyle = "rgba(255,80,120,0.7)";
            ctx.font = "10px 'JetBrains Mono', monospace";
            ctx.fillText(hzToNote(p.freq), textX, y - 20);
          }
        });
      } else {
        // Waveform
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, H / 2);
        ctx.lineTo(W, H / 2);
        ctx.stroke();

        ctx.beginPath();
        const sliceWidth = W / timeData.length;
        for (let i = 0; i < timeData.length; i++) {
          const x = i * sliceWidth;
          const y = (1 - timeData[i]) * H * 0.5;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "#00e6c8";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Spectrogram
      if (viewMode === "spectrogram") {
        const sgCanvas = spectrogramCanvasRef.current;
        if (sgCanvas) {
          const sgCtx = sgCanvas.getContext("2d");
          const sgW = sgCanvas.width;
          const sgH = sgCanvas.height;
          const col = spectrogramColRef.current % sgW;
          const maxBin = Math.min(Math.ceil(maxFreqDisplay / binWidth), bufLen);

          for (let i = 0; i < sgH; i++) {
            const bin = Math.floor((i / sgH) * maxBin);
            const val = Math.max(freqData[bin], -100);
            const norm = (val + 100) / 70; // map -100..-30 to 0..1
            const clamped = Math.max(0, Math.min(1, norm));
            const r = Math.floor(clamped * 200 + (clamped > 0.7 ? (clamped - 0.7) * 180 : 0));
            const g = Math.floor(clamped * 230);
            const b = Math.floor(100 + clamped * 155);
            sgCtx.fillStyle = `rgb(${r},${g},${b})`;
            sgCtx.fillRect(col, sgH - i - 1, 2, 1);
          }

          // Cursor line
          sgCtx.fillStyle = "rgba(255,255,255,0.5)";
          sgCtx.fillRect((col + 2) % sgW, 0, 1, sgH);

          spectrogramColRef.current = col + 2;
        }
      }
    };

    draw();
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isRunning, viewMode, maxFreqDisplay]);

  // Load history from storage on mount
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const result = await window.storage.get("fft-history");
        if (result && result.value) {
          setHistory(JSON.parse(result.value));
        }
      } catch (e) {
        // No stored history yet
      }
    };
    loadHistory();
  }, []);

  // Persist history
  useEffect(() => {
    if (history.length > 0) {
      window.storage.set("fft-history", JSON.stringify(history)).catch(() => {});
    }
  }, [history]);

  const clearHistory = async () => {
    setHistory([]);
    try {
      await window.storage.delete("fft-history");
    } catch (e) {}
  };

  const meterWidth = Math.max(0, Math.min(100, (rmsLevel + 80) / 60 * 100));
  const meterColor = rmsLevel > -10 ? "#ff3050" : rmsLevel > -30 ? "#ffb43c" : "#00e6c8";

  return (
    <div
      style={{
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
        background: "#08080d",
        color: "#e0e0e8",
        minHeight: "100vh",
        padding: "0",
        margin: "0",
      }}
    >
      <link
        href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Space+Grotesk:wght@300;500;700&display=swap"
        rel="stylesheet"
      />

      {/* Header */}
      <div
        style={{
          padding: "20px 24px 12px",
          borderBottom: "1px solid rgba(0,230,200,0.1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "8px",
              background: "linear-gradient(135deg, #00e6c8, #6040ff)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "18px",
            }}
          >
            ∿
          </div>
          <div>
            <h1
              style={{
                fontSize: "16px",
                fontWeight: 700,
                margin: 0,
                fontFamily: "'Space Grotesk', sans-serif",
                letterSpacing: "-0.5px",
              }}
            >
              Natural Frequency Diagnostics
            </h1>
            <span
              style={{
                fontSize: "10px",
                color: "rgba(0,230,200,0.5)",
                textTransform: "uppercase",
                letterSpacing: "2px",
              }}
            >
              FFT Analyzer · {FFT_SIZE}-pt · {(SAMPLE_RATE / FFT_SIZE).toFixed(1)} Hz res
            </span>
          </div>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            onClick={showHistory ? () => setShowHistory(false) : () => setShowHistory(true)}
            style={{
              background: showHistory ? "rgba(0,230,200,0.15)" : "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "#e0e0e8",
              padding: "6px 12px",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "11px",
              fontFamily: "inherit",
            }}
          >
            History ({history.length})
          </button>
          <button
            onClick={isRunning ? stopAudio : startAudio}
            style={{
              background: isRunning
                ? "rgba(255,60,90,0.2)"
                : "linear-gradient(135deg, #00e6c8, #00b4ff)",
              border: "none",
              color: isRunning ? "#ff3c5a" : "#08080d",
              padding: "8px 20px",
              borderRadius: "8px",
              cursor: "pointer",
              fontWeight: 700,
              fontSize: "12px",
              fontFamily: "inherit",
              letterSpacing: "1px",
              textTransform: "uppercase",
            }}
          >
            {isRunning ? "■ Stop" : "● Start"}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div
          style={{
            padding: "12px 24px",
            background: "rgba(255,50,80,0.1)",
            color: "#ff5070",
            fontSize: "12px",
          }}
        >
          {errorMsg}
        </div>
      )}

      {/* Fundamental Frequency Display */}
      <div
        style={{
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          gap: "24px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "2px",
              color: "rgba(255,80,120,0.6)",
              marginBottom: "4px",
            }}
          >
            Fundamental
          </div>
          <div
            style={{
              fontSize: "32px",
              fontWeight: 700,
              color: "#ff5078",
              fontFamily: "'Space Grotesk', sans-serif",
              letterSpacing: "-1px",
            }}
          >
            {fundamentalFreq ? formatFreq(fundamentalFreq) : "—"}
          </div>
          {fundamentalFreq && (
            <div style={{ fontSize: "12px", color: "rgba(255,180,60,0.8)", marginTop: "2px" }}>
              {hzToNote(fundamentalFreq)}
            </div>
          )}
        </div>

        {/* Level Meter */}
        <div style={{ flex: 1, minWidth: 150 }}>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "2px",
              color: "rgba(255,255,255,0.3)",
              marginBottom: "6px",
            }}
          >
            Level {rmsLevel > -100 ? `${rmsLevel.toFixed(1)} dBFS` : ""}
          </div>
          <div
            style={{
              height: "6px",
              background: "rgba(255,255,255,0.05)",
              borderRadius: "3px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${meterWidth}%`,
                height: "100%",
                background: meterColor,
                borderRadius: "3px",
                transition: "width 0.05s",
              }}
            />
          </div>
        </div>

        {/* Capture */}
        <button
          onClick={captureSnapshot}
          disabled={!fundamentalFreq}
          style={{
            background: fundamentalFreq ? "rgba(0,230,200,0.1)" : "rgba(255,255,255,0.03)",
            border: "1px solid rgba(0,230,200,0.2)",
            color: fundamentalFreq ? "#00e6c8" : "rgba(255,255,255,0.2)",
            padding: "8px 16px",
            borderRadius: "8px",
            cursor: fundamentalFreq ? "pointer" : "default",
            fontSize: "11px",
            fontFamily: "inherit",
            fontWeight: 500,
          }}
        >
          ⬇ Capture
        </button>
      </div>

      {/* Controls */}
      <div
        style={{
          padding: "0 24px 12px",
          display: "flex",
          gap: "8px",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {["spectrum", "spectrogram", "waveform"].map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            style={{
              background:
                viewMode === mode ? "rgba(0,230,200,0.12)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${
                viewMode === mode ? "rgba(0,230,200,0.3)" : "rgba(255,255,255,0.06)"
              }`,
              color: viewMode === mode ? "#00e6c8" : "rgba(255,255,255,0.4)",
              padding: "5px 12px",
              borderRadius: "5px",
              cursor: "pointer",
              fontSize: "10px",
              fontFamily: "inherit",
              textTransform: "uppercase",
              letterSpacing: "1px",
            }}
          >
            {mode}
          </button>
        ))}
        <span style={{ color: "rgba(255,255,255,0.15)", margin: "0 4px" }}>│</span>
        <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)" }}>Range:</span>
        {[1000, 2000, 4000, 8000, 20000].map((f) => (
          <button
            key={f}
            onClick={() => setMaxFreqDisplay(f)}
            style={{
              background:
                maxFreqDisplay === f ? "rgba(100,64,255,0.15)" : "transparent",
              border: `1px solid ${
                maxFreqDisplay === f ? "rgba(100,64,255,0.3)" : "rgba(255,255,255,0.06)"
              }`,
              color: maxFreqDisplay === f ? "#a080ff" : "rgba(255,255,255,0.3)",
              padding: "4px 8px",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "10px",
              fontFamily: "inherit",
            }}
          >
            {f >= 1000 ? f / 1000 + "k" : f}
          </button>
        ))}
      </div>

      {/* Canvas */}
      <div style={{ padding: "0 24px" }}>
        <canvas
          ref={canvasRef}
          width={900}
          height={300}
          style={{
            width: "100%",
            height: "auto",
            borderRadius: "8px",
            border: "1px solid rgba(255,255,255,0.06)",
            background: "#0a0a0f",
          }}
        />
        {viewMode === "spectrogram" && (
          <canvas
            ref={spectrogramCanvasRef}
            width={900}
            height={150}
            style={{
              width: "100%",
              height: "auto",
              borderRadius: "8px",
              border: "1px solid rgba(255,255,255,0.06)",
              background: "#0a0a0f",
              marginTop: "8px",
            }}
          />
        )}
      </div>

      {/* Detected Peaks Table */}
      <div style={{ padding: "16px 24px" }}>
        <div
          style={{
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "2px",
            color: "rgba(255,255,255,0.3)",
            marginBottom: "8px",
          }}
        >
          Detected Peaks
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: "6px",
          }}
        >
          {peaks.length === 0 && !isRunning && (
            <div style={{ fontSize: "12px", color: "rgba(255,255,255,0.2)", padding: "8px 0" }}>
              Press Start to begin analysis
            </div>
          )}
          {peaks.slice(0, 6).map((p, i) => (
            <div
              key={i}
              style={{
                background: i === 0 ? "rgba(255,80,120,0.06)" : "rgba(255,255,255,0.02)",
                border: `1px solid ${
                  i === 0 ? "rgba(255,80,120,0.15)" : "rgba(255,255,255,0.04)"
                }`,
                borderRadius: "6px",
                padding: "8px 12px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    color: i === 0 ? "#ff5078" : "#e0e0e8",
                  }}
                >
                  {formatFreq(p.freq)}
                </div>
                <div style={{ fontSize: "10px", color: "rgba(255,180,60,0.6)" }}>
                  {hzToNote(p.freq)}
                </div>
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: "rgba(255,255,255,0.4)",
                }}
              >
                {p.magnitude.toFixed(1)} dB
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Harmonics Analysis */}
      {fundamentalFreq && peaks.length >= 2 && (
        <div style={{ padding: "0 24px 16px" }}>
          <div
            style={{
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "2px",
              color: "rgba(255,255,255,0.3)",
              marginBottom: "8px",
            }}
          >
            Harmonic Analysis
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {[2, 3, 4, 5, 6].map((n) => {
              const expected = fundamentalFreq * n;
              const found = peaks.find(
                (p) => Math.abs(p.freq - expected) < expected * 0.04
              );
              return (
                <div
                  key={n}
                  style={{
                    fontSize: "11px",
                    padding: "4px 10px",
                    borderRadius: "4px",
                    background: found
                      ? "rgba(0,230,200,0.08)"
                      : "rgba(255,255,255,0.02)",
                    border: `1px solid ${
                      found ? "rgba(0,230,200,0.2)" : "rgba(255,255,255,0.04)"
                    }`,
                    color: found ? "#00e6c8" : "rgba(255,255,255,0.2)",
                  }}
                >
                  {n}× {formatFreq(expected)}{" "}
                  {found ? `(${found.magnitude.toFixed(0)} dB)` : "—"}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* History Panel */}
      {showHistory && (
        <div
          style={{
            padding: "16px 24px",
            borderTop: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "12px",
            }}
          >
            <div
              style={{
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "2px",
                color: "rgba(255,255,255,0.3)",
              }}
            >
              Capture History
            </div>
            {history.length > 0 && (
              <button
                onClick={clearHistory}
                style={{
                  background: "rgba(255,50,80,0.1)",
                  border: "1px solid rgba(255,50,80,0.2)",
                  color: "#ff5070",
                  padding: "4px 10px",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "10px",
                  fontFamily: "inherit",
                }}
              >
                Clear All
              </button>
            )}
          </div>
          {history.length === 0 ? (
            <div style={{ fontSize: "12px", color: "rgba(255,255,255,0.2)" }}>
              No captures yet. Hit "Capture" during analysis.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {history.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    border: "1px solid rgba(255,255,255,0.04)",
                    borderRadius: "6px",
                    padding: "10px 14px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "14px", fontWeight: 600, color: "#ff5078" }}>
                      {formatFreq(entry.fundamental)}
                    </div>
                    <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)" }}>
                      {entry.timestamp} · {entry.rms.toFixed(1)} dBFS
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {entry.peaks.slice(0, 3).map((p, i) => (
                      <span
                        key={i}
                        style={{
                          fontSize: "10px",
                          padding: "2px 6px",
                          borderRadius: "3px",
                          background: "rgba(255,255,255,0.04)",
                          color: "rgba(255,255,255,0.4)",
                        }}
                      >
                        {formatFreq(p.freq)}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          padding: "16px 24px",
          borderTop: "1px solid rgba(255,255,255,0.04)",
          fontSize: "10px",
          color: "rgba(255,255,255,0.15)",
          textAlign: "center",
        }}
      >
        FFT Size: {FFT_SIZE} · Bin Resolution: {(SAMPLE_RATE / FFT_SIZE).toFixed(2)} Hz ·
        Smoothing: {SMOOTHING} · Range: 20 Hz – 20 kHz
      </div>
    </div>
  );
}
