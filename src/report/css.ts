/** The memory report's stylesheet: the web app's design tokens (packages/ui theme.css, light and
 * dark) and the classes its memory pages compose — SurfaceCard tiles, Badge variants, scope chips
 * — so the local report reads as the same product as the session page it links into. */

export const REPORT_CSS = `
  :root {
    --surface-0: 0 0% 100%;
    --surface-1: 220 20% 97%;
    --surface-1-hover: 220 17% 93%;
    --surface-2: 210 17% 93%;
    --prose-primary: 217 14% 30%;
    --prose-faint: 214 11% 40%;
    --prose-strong: 0 0% 0%;
    --prose-link: 224 76% 48%;
    --status-success: 120 60% 40%;
    --status-warning: 40 90% 32%;
    --status-error: 0 84% 60%;
    --highlight-light: 252 100% 98%;
    --highlight-primary: 258 90% 66%;
    --highlight-strong: 263 70% 50%;
    --accent-light: 68 20% 95%;
    --accent-primary: 68 18% 78%;
    --accent-strong: 68 30% 38%;
    --line-0: 210 17% 93%;
    --line-1: 216 18% 89%;
    --line-2: 215 18% 87%;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface-0: 0 0% 0%;
      --surface-1: 0 0% 8%;
      --surface-1-hover: 0 0% 12%;
      --surface-2: 0 0% 13%;
      --prose-primary: 215 18% 87%;
      --prose-faint: 220 15% 76%;
      --prose-strong: 0 0% 100%;
      --prose-link: 212 96% 78%;
      --status-success: 120 60% 48%;
      --status-warning: 40 94% 55%;
      --status-error: 4 86% 58%;
      --highlight-light: 240 24% 14%;
      --highlight-primary: 258 90% 70%;
      --highlight-strong: 251 95% 92%;
      --accent-light: 68 10% 14%;
      --accent-primary: 68 12% 30%;
      --accent-strong: 68 18% 65%;
      --line-0: 0 0% 12%;
      --line-1: 0 0% 19%;
      --line-2: 0 0% 24%;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: hsl(var(--prose-primary));
    background: hsl(var(--surface-0));
  }
  a { color: inherit; text-decoration: none; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 40px 24px 64px; display: flex; flex-direction: column; gap: 32px; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .faint { color: hsl(var(--prose-faint)); }
  .strong { color: hsl(var(--prose-strong)); }
  .xs { font-size: 12px; }
  .nums { font-variant-numeric: tabular-nums; }
  .link { color: hsl(var(--prose-link)); font-size: 12px; }
  .link:hover { text-decoration: underline; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .row .push { margin-left: auto; }
  .stack { display: flex; flex-direction: column; gap: 8px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  @media (max-width: 720px) { .grid { grid-template-columns: minmax(0, 1fr); } }

  header.hero { display: flex; flex-direction: column; gap: 6px; }
  .eyebrow { font-size: 12px; color: hsl(var(--prose-faint)); margin: 0; }
  h1 { margin: 0; font-size: 24px; font-weight: 600; color: hsl(var(--prose-strong)); letter-spacing: -0.01em; }
  h2 { margin: 0 0 8px; font-size: 16px; font-weight: 600; color: hsl(var(--prose-strong)); }
  h3 { margin: 0; font-size: 14px; font-weight: 600; color: hsl(var(--prose-strong)); }
  p { margin: 0; }

  .card { background: hsl(var(--surface-1)); border-radius: 12px; padding: 16px; min-width: 0; }
  a.card { display: flex; flex-direction: column; gap: 8px; transition: background-color 0.15s; }
  a.card:hover { background: hsl(var(--surface-1-hover)); }
  .card-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: hsl(var(--prose-strong)); }
  .snippet { font-size: 12px; color: hsl(var(--prose-faint)); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .tombstone { flex: 1; font-style: italic; color: hsl(var(--prose-faint)); }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .stat { display: flex; flex-direction: column; gap: 4px; }
  .stat .value { font-size: 24px; font-weight: 600; color: hsl(var(--prose-strong)); font-variant-numeric: tabular-nums; }

  .badge {
    display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
    height: 20px; padding: 0 8px; font-size: 11px; white-space: nowrap;
    border: 1px solid hsl(var(--line-1)); border-radius: 999px;
    background: hsl(var(--surface-1)); color: hsl(var(--prose-primary));
    max-width: 16rem; overflow: hidden; text-overflow: ellipsis;
  }
  .badge.neutral { background: hsl(var(--surface-2)); border-color: hsl(var(--line-2)); }
  .badge.faint { background: hsl(var(--surface-0)); color: hsl(var(--prose-faint)); border-color: hsl(var(--line-0)); }
  .badge.accent { background: hsl(var(--accent-light)); color: hsl(var(--accent-strong)); border-color: hsl(var(--accent-primary)); }
  .badge.highlight { background: hsl(var(--highlight-light)); color: hsl(var(--highlight-strong)); border-color: hsl(var(--highlight-primary)); }
  .badge.success { background: hsl(var(--status-success) / 0.1); color: hsl(var(--status-success)); border-color: hsl(var(--status-success) / 0.2); }
  .badge.warning { background: hsl(var(--status-warning) / 0.1); color: hsl(var(--status-warning)); border-color: hsl(var(--status-warning) / 0.2); }
  .badge.error { background: hsl(var(--status-error) / 0.1); color: hsl(var(--status-error)); border-color: hsl(var(--status-error) / 0.2); }

  dl.meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px 24px; margin: 0; }
  @media (max-width: 720px) { dl.meta { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  dl.meta dt { font-size: 12px; color: hsl(var(--prose-faint)); }
  dl.meta dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: hsl(var(--prose-primary)); }
  .divided { border-top: 1px solid hsl(var(--line-0)); padding-top: 12px; }

  details.session { border-top: 1px solid hsl(var(--line-0)); }
  details.session > summary {
    list-style: none; cursor: pointer; padding: 12px 4px;
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  }
  details.session > summary::-webkit-details-marker { display: none; }
  details.session > summary::before { content: "\\25B8"; color: hsl(var(--prose-faint)); width: 12px; }
  details.session[open] > summary::before { content: "\\25BE"; }
  details.session > summary:hover { background: hsl(var(--surface-1)); border-radius: 8px; }
  .session-body { display: flex; flex-direction: column; gap: 24px; padding: 4px 0 24px 20px; }

  .toolbar button {
    font: inherit; font-size: 12px; cursor: pointer; height: 28px; padding: 0 12px; border-radius: 8px;
    border: 1px solid hsl(var(--line-1)); background: hsl(var(--surface-1)); color: hsl(var(--prose-primary));
  }
  footer { font-size: 12px; color: hsl(var(--prose-faint)); border-top: 1px solid hsl(var(--line-0)); padding-top: 16px; }
  @media print {
    .toolbar { display: none; }
    details.session > summary::before { content: ""; }
  }
`;
