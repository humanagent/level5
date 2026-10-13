# tempo and beat phase of a track from its onset envelope, plus the loud/quiet shape per bar
import sys, subprocess, numpy as np
sr = 22050; x = np.frombuffer(subprocess.run(["ffmpeg", "-loglevel", "error", "-i", sys.argv[1], "-f", "f32le", "-ac", "1", "-ar", str(sr), "-"], capture_output=True).stdout, np.float32)
hop, n = 256, 1024; frames = np.lib.stride_tricks.sliding_window_view(x, n)[::hop] * np.hanning(n)
S = np.abs(np.fft.rfft(frames, axis=1)); lo = S[:, :12].sum(1)  # kick band
flux = np.maximum(0, np.diff(np.log1p(S), axis=0)).sum(1); fps = sr / hop
env = flux - np.convolve(flux, np.ones(16) / 16, "same"); env = np.maximum(env, 0)
best = max(((np.dot(env[:-int(round(fps * 60 / b))], env[int(round(fps * 60 / b)):]), b) for b in np.arange(110, 150, .05)))[1]
period = fps * 60 / best
phase = max(range(int(period)), key=lambda p: env[np.round(np.arange(p, len(env), period)).astype(int)].sum())
beat0 = phase / fps; bar = 4 * 60 / best
print(f"bpm {best:.2f} beat0 {beat0:.3f}s bar {bar:.3f}s")
rms = lambda a, b: 20 * np.log10(np.sqrt(np.mean(x[int(a * sr):int(b * sr)] ** 2)) + 1e-9)
kick = lambda a, b: lo[int(a * fps):int(b * fps)].mean()
km = lo.mean()
print(" ".join(f"{i}:{beat0 + i * bar:.2f}:{rms(beat0 + i * bar, beat0 + (i + 1) * bar):.0f}{'K' if kick(beat0 + i * bar, beat0 + (i + 1) * bar) > km else '-'}" for i in range(int((len(x) / sr - beat0) / bar))))
