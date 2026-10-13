import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const TL = JSON.parse(readFileSync("timeline.json", "utf8"));
const [,, out = "frames", fps = 30, only] = process.argv;
const dur = TL.at(-1).b;
const b = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on("pageerror", (e) => console.log("pageerror:", e.message));
await p.addInitScript((tl) => { window.TL = tl; }, TL);
await p.goto("file://" + process.cwd() + "/scene.html", { waitUntil: "networkidle" });
await p.evaluate(() => window.ready);
const ts = only ? only.split(",").map(Number) : Array.from({ length: Math.round(dur * fps) }, (_, i) => i / fps);
for (let i = 0; i < ts.length; i++) {
  await p.evaluate((t) => window.render(t), ts[i]);
  await p.screenshot({ path: `${out}/${String(i).padStart(4, "0")}.png` });
}
await b.close();
