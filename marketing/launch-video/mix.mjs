// voice lines at their scene times, cleaned up, with the music ducking under them
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const TL = JSON.parse(readFileSync("timeline.json", "utf8"));
const ins = TL.flatMap((s) => ["-i", s.f]);
const vo = TL.map((s, i) => `[${i + 1}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,adelay=${Math.round(s.vo * 1000)}|${Math.round(s.vo * 1000)}[v${i}]`).join(";");
const f = `${vo};${TL.map((_, i) => `[v${i}]`).join("")}amix=inputs=${TL.length}:normalize=0,highpass=f=90,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,volume=2.2,asplit[vo][sc0];[sc0]apad[sc];` +
  `[0:a]volume=0.5[m];[m][sc]sidechaincompress=threshold=0.04:ratio=4:attack=20:release=350[md];[md][vo]amix=inputs=2:normalize=0[out]`;
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", process.env.MUSIC || "music.wav", ...ins, "-filter_complex", f, "-map", "[out]", "-ar", "48000", "mix.wav"], { stdio: "inherit" });
console.log("mix.wav");
