// cut the single take into one clip per line (start to the next line's start, trailing silence trimmed),
// then lay the scenes out: each lasts its clip plus room, never less than its minimum
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync as x } from "node:child_process";
const A = JSON.parse(readFileSync("vo2/align.json", "utf8")), S = JSON.parse(readFileSync("script.json", "utf8"));
const total = +x("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "vo2/take.mp3"]).toString();
let t = 0; const out = [];
A.forEach((a, i) => {
  const s0 = Math.max(0, a.start - .12), s1 = i + 1 < A.length ? A[i + 1].start - .1 : total, f = `vo2/${a.id}.wav`;
  x("ffmpeg", ["-loglevel", "error", "-y", "-i", "vo2/take.mp3", "-ss", s0.toFixed(3), "-to", s1.toFixed(3), "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,afade=t=in:d=0.02", "-ar", "48000", f]);
  const d = +x("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString();
  const dur = Math.max(S[i].min, d + .6);
  out.push({ id: a.id, a: +t.toFixed(2), b: +(t + dur).toFixed(2), vo: +(t + .35).toFixed(2), d: +d.toFixed(2), f });
  t += dur;
});
writeFileSync("timeline.json", JSON.stringify(out, null, 1)); console.log(out.map((s) => `${s.id.padEnd(8)} ${s.a}-${s.b} (vo ${s.d})`).join("\n"), "\ntotal", t.toFixed(2));
