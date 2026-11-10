// Wraps the claude.ai artifact source (src/proofmark.html) into a standalone page
// that loads public/shim.js first, so the same app runs on this server.
import fs from "node:fs";
const src = fs.readFileSync(new URL("../src/proofmark.html", import.meta.url), "utf8");
const reset = "*,::before,::after{box-sizing:border-box}:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}";
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${reset}</style><script src="/shim.js"></script></head><body>\n${src}\n</body></html>\n`;
fs.writeFileSync(new URL("../public/index.html", import.meta.url), html);
console.log("Built public/index.html");
