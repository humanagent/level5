# rebuild the track bar by bar so its drops land on the cuts; 8 ms crossfades at each seam
import sys, subprocess, numpy as np
src, out, trim = sys.argv[1], sys.argv[2], float(sys.argv[3]); seq = [int(b) for b in sys.argv[4].split(",")]
sr, beat0, bar = 48000, 0.058, 4 * 60 / 121.55
x = np.frombuffer(subprocess.run(["ffmpeg", "-loglevel", "error", "-i", src, "-f", "f32le", "-ac", "2", "-ar", str(sr), "-"], capture_output=True).stdout, np.float32).reshape(-1, 2)
xf = int(.008 * sr); fade = np.linspace(0, 1, xf)[:, None]; y = np.zeros((0, 2), np.float32)
for b in seq:
    a = int(round((beat0 + b * bar) * sr)); s = x[max(0, a - xf):a + int(round(bar * sr))].copy()
    if len(y) >= xf and len(s) > xf: y[-xf:] = y[-xf:] * (1 - fade) + s[:xf] * fade; s = s[xf:]
    y = np.concatenate([y, s])
y = y[int(trim * sr):]
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "f32le", "-ac", "2", "-ar", str(sr), "-i", "-", out], input=y.astype(np.float32).tobytes())
print(out, len(y) / sr)
