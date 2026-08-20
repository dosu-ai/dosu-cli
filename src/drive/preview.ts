import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface PreviewSession {
  key: string;
  repository: string;
  harness: string;
  nativeId: string;
  title: string;
  started: string;
  updated: string;
  sample?: string;
  records: number;
  bytes: number;
  redactions: number;
}

export interface PreviewController {
  url: string;
  waitForDecision(): Promise<string[] | undefined>;
  close(): Promise<void>;
}

export async function startPreview(
  sessions: readonly PreviewSession[],
): Promise<PreviewController> {
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  let selected = new Set(byKey.keys());
  let settled = false;
  let resolveDecision: (value: string[] | undefined) => void = () => undefined;
  const decision = new Promise<string[] | undefined>((resolve) => {
    resolveDecision = resolve;
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/preview")) {
        html(response, previewHTML());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/preview") {
        json(response, 200, summary([...byKey.values()], selected));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/select") {
        const body = await readJSON(request);
        if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error("Expected selected keys");
        const keys = body.keys.filter((key): key is string => typeof key === "string");
        if (keys.some((key) => !byKey.has(key))) throw new Error("Unknown session selection");
        selected = new Set(keys);
        json(response, 200, summary([...byKey.values()], selected));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/approve") {
        json(response, 200, { approved: selected.size });
        if (!settled) {
          settled = true;
          resolveDecision([...selected]);
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/cancel") {
        json(response, 200, { cancelled: true });
        if (!settled) {
          settled = true;
          resolveDecision(undefined);
        }
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/preview`,
    waitForDecision: () => decision,
    close: async () => {
      if (!settled) {
        settled = true;
        resolveDecision(undefined);
      }
      await closeServer(server);
    },
  };
}

function summary(sessions: PreviewSession[], selected: Set<string>) {
  const rows = sessions.map((session) => ({ ...session, selected: selected.has(session.key) }));
  const included = rows.filter((session) => session.selected);
  return {
    sessions: rows,
    totals: {
      selected: included.length,
      excluded: rows.length - included.length,
      records: included.reduce((sum, session) => sum + session.records, 0),
      bytes: included.reduce((sum, session) => sum + session.bytes, 0),
      redactions: included.reduce((sum, session) => sum + session.redactions, 0),
    },
  };
}

function previewHTML(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Dosu Drive preview</title><style>
body{font:15px ui-sans-serif,system-ui;margin:40px auto;max-width:900px;color:#171717;padding:0 20px}h1{font-size:28px}p{line-height:1.5}.safe{background:#f1f8f4;border:1px solid #b7dfc5;padding:16px;border-radius:10px}.session{display:grid;grid-template-columns:28px 1fr auto;gap:12px;padding:14px 0;border-bottom:1px solid #e5e5e5}.meta{color:#666;font-size:13px}.sample{white-space:pre-wrap;background:#f7f7f7;padding:10px;border-radius:6px;margin-top:8px}button{border:0;border-radius:8px;padding:11px 16px;font-weight:600;cursor:pointer}.approve{background:#171717;color:white}.cancel{background:#eee;margin-left:8px}#actions{position:sticky;bottom:0;background:white;padding:18px 0;border-top:1px solid #ddd}
</style></head><body><h1>Review exactly what will be uploaded</h1>
<p>Inspect every selected session and exclude anything before it leaves this computer.</p>
<div class="safe"><strong>Dosu will not modify or delete any local files.</strong><br>
All searchable content from selected sessions will be copied to this Drive after credential redaction. Conversations, tool output, commands, file paths, edit history, and session metadata are included.</div>
<p id="summary">Loading local preview…</p><main id="sessions"></main><div id="actions"><button class="approve" id="approve">Approve &amp; Upload</button><button class="cancel" id="cancel">Cancel</button></div>
<script>
let data; const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){data=await fetch('/api/preview').then(r=>r.json());render()}
function render(){const t=data.totals;document.querySelector('#summary').textContent=t.selected+' sessions · '+t.records+' searchable records · '+t.redactions+' potential credentials replaced · '+t.excluded+' excluded';document.querySelector('#sessions').innerHTML=data.sessions.map(s=>'<label class="session"><input type="checkbox" '+(s.selected?'checked':'')+' data-key="'+esc(s.key)+'"><div><strong>'+esc(s.title)+'</strong><div class="meta">'+esc(s.repository)+' · '+esc(s.harness)+' · '+esc(s.updated)+'</div>'+(s.sample?'<div class="sample">'+esc(s.sample)+'</div>':'')+'</div><span class="meta">'+s.records+' records</span></label>').join('');document.querySelectorAll('input').forEach(el=>el.onchange=select)}
async function select(){const keys=[...document.querySelectorAll('input:checked')].map(el=>el.dataset.key);data=await fetch('/api/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keys})}).then(r=>r.json());render()}
document.querySelector('#approve').onclick=async()=>{await fetch('/api/approve',{method:'POST'});document.body.innerHTML='<h1>Approved</h1><p>Return to the terminal to watch the upload.</p>'};document.querySelector('#cancel').onclick=async()=>{await fetch('/api/cancel',{method:'POST'});window.close()};load();
</script></body></html>`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJSON(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("Preview request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function html(response: import("node:http").ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
