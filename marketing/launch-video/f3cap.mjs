// real-time capture of the live landing's 3D factory, slowly turned by a drag, at 2x for a crisp zoom
import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
await p.goto("https://factory-status.fly.dev/", { waitUntil: "networkidle" });
await p.addStyleTag({ content: ".f3-hint,.f3-leg,.lnav{display:none!important}" });
const r = await p.evaluate(() => { const e = document.getElementById("f3"); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await p.waitForTimeout(3000);
const cx = r.x + r.w / 2, cy = r.y + r.h / 2; await p.mouse.move(cx, cy); await p.mouse.down();
const N = +process.argv[2] || 120;
for (let i = 0; i < N; i++) {
  await p.mouse.move(cx - i * 1.6, cy, { steps: 1 });
  await p.locator("#f3").screenshot({ path: `f3/${String(i).padStart(4, "0")}.png` });
}
await p.mouse.up(); await b.close();
