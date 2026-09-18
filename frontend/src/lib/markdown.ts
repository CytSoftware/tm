/**
 * The one markdown renderer for agent- and pipeline-written content (LLM wiki
 * pages, meeting briefs and transcripts).
 *
 * `html: false` is the security posture: this content is machine-generated
 * and goes into `dangerouslySetInnerHTML`, and the app ships no HTML
 * sanitizer. Do not construct a second instance with `html: true`.
 */

import MarkdownIt from "markdown-it";

export const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

// With html:false the only injection surface left is link/image URL *schemes*.
const DANGEROUS_SCHEME = /^(javascript|vbscript|data|file):/i;
md.validateLink = (url: string) => {
  let s = (url || "").trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    // malformed encoding — fall through and test the raw string
  }
  // strip control chars / whitespace (avoids a control-char regex literal)
  s = Array.from(s)
    .filter((c) => c.charCodeAt(0) > 0x20)
    .join("");
  return !DANGEROUS_SCHEME.test(s) || s.startsWith("#w/");
};

// External links open in a new tab; in-app `#…` anchors stay put.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) =>
    self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href") ?? "";
  if (/^https?:/i.test(href)) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};
