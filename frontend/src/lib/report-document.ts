/**
 * Wraps a bot-written report body in the page the sandboxed iframe renders.
 *
 * The class + CSS-variable contract below is what `publish_report`'s docstring
 * (backend/apps/mcp_server/server.py) tells bots to use — change both together.
 * Because the stylesheet is injected at render time, editing it restyles every
 * past report too.
 *
 * Security: the iframe is `sandbox="allow-scripts"` without
 * `allow-same-origin`, so the report runs in an opaque origin with no access to
 * the session or the app. The CSP blocks every network fetch, which makes
 * reports self-contained by force and keeps their data from leaving the page.
 */

import { CHART_CHROME } from "./chart-colors";

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
].join("; ");

const { light, dark } = CHART_CHROME;

// Series hues: the four that pass the dataviz validator as a set (same as
// lib/meeting-meta.ts), light / dark.
const CSS = `
:root{color-scheme:light;--bg:${light.surface};--fg:${light.primaryInk};--muted:${light.secondaryInk};
--border:${light.gridline};--card:#ffffff;--up:#008300;--down:#c4352b;
--c1:#2a78d6;--c2:#008300;--c3:#eda100;--c4:#e87ba4}
:root.dark{color-scheme:dark;--bg:#111110;--fg:${dark.primaryInk};--muted:${dark.mutedInk};
--border:${dark.gridline};--card:${dark.surface};--up:#3fae5a;--down:#e5604f;
--c1:#3987e5;--c2:#008300;--c3:#c98500;--c4:#d55181}
*{box-sizing:border-box}
body{margin:0 auto;max-width:880px;padding:24px 16px 56px;background:var(--bg);color:var(--fg);
font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
h1{font-size:22px;line-height:1.25;margin:0 0 6px;font-weight:600}
h2{font-size:16px;margin:32px 0 10px;font-weight:600}
h3{font-size:14px;margin:20px 0 6px;font-weight:600}
p{margin:8px 0}
a{color:var(--c1)}
.muted{color:var(--muted)}
.up{color:var(--up)}.down{color:var(--down)}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:12px 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.kpi .label{font-size:12px;color:var(--muted)}
.kpi .value{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.kpi .delta{font-size:12px;font-variant-numeric:tabular-nums}
.table-wrap{overflow-x:auto;margin:12px 0;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th{font-size:12px;font-weight:500;color:var(--muted);white-space:nowrap}
.num{text-align:right;white-space:nowrap}
.tag{display:inline-block;padding:0 8px;border:1px solid var(--border);border-radius:999px;font-size:12px;color:var(--muted)}
.chart{margin:12px 0}
svg{display:block;max-width:100%;height:auto}
.chart text{fill:var(--muted);font-size:11px}
ul,ol{padding-left:20px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
`;

export function reportDocument(body: string, isDark: boolean): string {
  return `<!doctype html><html class="${isDark ? "dark" : ""}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<base target="_blank"><style>${CSS}</style></head><body>${body}</body></html>`;
}
