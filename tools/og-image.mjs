// The share previews (Open Graph / Twitter): public/og.jpg in French and
// public/og-en.jpg in English, 1200×630, the key art under the title and its
// tagline, set in the game's Didot. index.html points at the first,
// public/en/index.html (the English share link) at the second.
// Usage: node tools/og-image.mjs   (macOS: needs Google Chrome and Didot)
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const art = readFileSync(`${root}art/raw/keyart-landscape.webp`).toString("base64");
const TAGLINES = {
  "og.jpg": "Stratégie en temps réel · Belle Époque · 1900",
  "og-en.jpg": "Real-time strategy · Belle Époque · 1900"
};

const page = (tagline) => `<!doctype html><html><head><style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #120c06; }
  .art { position: absolute; inset: 0; background: url(data:image/webp;base64,${art}) center 78% / cover; }
  .shade { position: absolute; inset: 0; background: radial-gradient(ellipse 70% 55% at 50% 28%, rgba(10,6,2,.45), transparent 70%); }
  .t { position: absolute; left: 0; right: 0; top: 64px; text-align: center; font-family: Didot, "Bodoni 72", serif; }
  h1 { margin: 0; font-size: 118px; font-weight: 700; letter-spacing: 6px; line-height: 1; color: #f0cf7e;
       text-shadow: 0 3px 0 #6b4a17, 0 6px 18px rgba(0,0,0,.75); }
  .rule { width: 460px; height: 3px; margin: 14px auto 10px; background: linear-gradient(90deg, transparent, #e8c46e 12%, #e8c46e 88%, transparent); }
  .tag { display: inline-block; padding: 8px 26px 10px; border-radius: 28px; background: rgba(12,8,4,.72);
         border: 1px solid rgba(232,196,110,.35); color: #f6ead0; font-size: 34px; font-style: italic; }
</style></head><body><div class="art"></div><div class="shade"></div>
<div class="t"><h1>PANACHE</h1><div class="rule"></div><div class="tag">${tagline}</div></div></body></html>`;

const browser = await chromium.launch({ channel: "chrome" });
const p = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const [file, tagline] of Object.entries(TAGLINES)) {
  await p.setContent(page(tagline));
  await p.evaluate(() => document.fonts.ready);
  writeFileSync(`${root}public/${file}`, await p.screenshot({ type: "jpeg", quality: 86 }));
  console.log(`public/${file}`);
}
await browser.close();
