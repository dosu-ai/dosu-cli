export const REPORT_CSS = `
  :root {
    --ink: #14201c;
    --muted: #5c6b64;
    --line: #d5ddd8;
    --bg: #f4f7f5;
    --card: #ffffff;
    --accent: #0b6e4f;
    --accent-soft: #e3f2eb;
    --warn: #8a5a00;
    --warn-bg: #fff6e5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    color: var(--ink);
    background: var(--bg);
    line-height: 1.45;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
  header.hero {
    border-bottom: 2px solid var(--ink);
    padding-bottom: 1.25rem;
    margin-bottom: 1.75rem;
  }
  .eyebrow {
    font-family: ui-sans-serif, system-ui, sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.72rem;
    color: var(--muted);
    margin: 0 0 0.4rem;
  }
  h1 { font-size: 2rem; font-weight: 600; margin: 0 0 0.5rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.25rem; margin: 2rem 0 0.75rem; border-top: 1px solid var(--line); padding-top: 1.25rem; }
  h3 { margin: 0; font-size: 1.05rem; }
  .lede { color: var(--muted); margin: 0 0 1rem; }
  .meta-line { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.85rem; color: var(--muted); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 0.6rem; margin: 1rem 0 0; }
  button, .btn {
    font-family: ui-sans-serif, system-ui, sans-serif;
    border: 1px solid var(--ink);
    background: var(--ink);
    color: #fff;
    padding: 0.55rem 0.9rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    text-decoration: none;
    display: inline-block;
  }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
  .stat { background: var(--card); border: 1px solid var(--line); padding: 0.85rem 1rem; border-radius: 6px; }
  .stat.highlight { background: var(--accent-soft); border-color: #b7d8c7; }
  .stat .label {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .stat .value { font-size: 1.35rem; font-weight: 600; margin-top: 0.25rem; }
  .pct { font-size: 0.9rem; font-weight: 500; color: var(--accent); }
  table { width: 100%; border-collapse: collapse; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.82rem; background: var(--card); }
  th, td { border-bottom: 1px solid var(--line); padding: 0.45rem 0.5rem; text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; margin: 0.75rem 0; }
  .card header { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: baseline; }
  .badge {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border: 1px solid var(--line);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    color: var(--muted);
  }
  .status-written { background: var(--accent-soft); color: var(--accent); border-color: #b7d8c7; }
  .status-pending { background: var(--warn-bg); color: var(--warn); border-color: #efd59a; }
  .status-proposed { background: #eef1f0; }
  .status-already_in_library { background: #eef1f0; }
  .note-body {
    white-space: pre-wrap;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.86rem;
    background: var(--bg);
    border-radius: 4px;
    padding: 0.75rem;
    overflow-x: auto;
  }
  .idea { font-size: 1.05rem; color: var(--ink); margin: 0.5rem 0 0.4rem; }
  .work { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.85rem; color: var(--muted); margin: 0.25rem 0 0.5rem; }
  .work-label {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin-right: 0.4rem;
  }
  .note-tech { margin-top: 0.6rem; }
  .note-tech summary { cursor: pointer; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.82rem; color: var(--muted); margin-top: 0.5rem; }
  .trace { margin-top: 0.65rem; }
  .trace > summary { cursor: pointer; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.82rem; color: var(--muted); }
  .trace-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: #e8eee9; margin: 0.5rem 0 0.35rem; }
  .tb { display: block; height: 100%; }
  .tb.context { background: var(--accent); }
  .tb.planning { background: #8a97a3; }
  .tb.other { background: #b5a89a; }
  .trace-legend { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.75rem; color: var(--muted); margin: 0 0 0.45rem; }
  .trace-steps { list-style: none; padding: 0; margin: 0.35rem 0 0; }
  .trace-steps li {
    display: grid;
    grid-template-columns: auto 1fr auto;
    column-gap: 0.4rem;
    align-items: baseline;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.78rem;
    padding: 0.16rem 0;
    border-bottom: 1px solid var(--line);
  }
  .trace-steps .chip { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 0.08rem 0.38rem; margin: 0; }
  .trace-steps .pv { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trace-steps .tok { font-variant-numeric: tabular-nums; color: var(--muted); text-align: right; }
  .ts-head { color: var(--muted); font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--line); }
  .ts-head .chip { background: none; border: 0; padding-left: 0; color: inherit; }
  .ts-head .pv, .ts-head .tok { color: inherit; overflow: visible; text-overflow: unset; }
  .ts-user .chip { background: #eef1f0; }
  .ts-context .chip { background: var(--accent-soft); color: var(--accent); border-color: #b7d8c7; }
  .ts-planning .chip { background: #eef1f4; }
  .ts-other .chip { background: #f3efe9; }
  .ts-code { opacity: 0.55; color: var(--muted); }
  .ts-omit .pv { font-style: italic; }
  .meta, .query, .muted, .footnote {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.85rem;
    color: var(--muted);
  }
  code { font-size: 0.84em; }
  footer.cta { margin-top: 2.5rem; padding: 1.25rem; background: var(--accent-soft); border: 1px solid #b7d8c7; border-radius: 8px; }
  footer.cta h2 { border: 0; padding: 0; margin: 0 0 0.5rem; }
  @media print {
    body { background: #fff; }
    .toolbar, .no-print { display: none !important; }
    .wrap { max-width: none; padding: 0; }
    .card, .stat { break-inside: avoid; }
    a { color: inherit; text-decoration: none; }
    details.trace > *:not(summary) { display: none !important; }
  }
`;
