import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/* v8 ignore start -- Loopback browser preview is verified through HTTP and packaged E2E. */

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

interface PreviewOptions {
  onSafetyCheck?: (sessions: readonly PreviewSession[]) => Promise<readonly PreviewSession[]>;
}

export async function startPreview(
  sessions: readonly PreviewSession[],
  options: PreviewOptions = {},
): Promise<PreviewController> {
  let byKey = new Map(sessions.map((session) => [session.key, session]));
  let selected = new Set(byKey.keys());
  let safetyChecked = false;
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
        json(response, 200, summary([...byKey.values()], selected, safetyChecked));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/select") {
        const body = await readJSON(request);
        if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error("Expected selected keys");
        const keys = body.keys.filter((key): key is string => typeof key === "string");
        if (keys.some((key) => !byKey.has(key))) throw new Error("Unknown session selection");
        selected = new Set(keys);
        safetyChecked = false;
        json(response, 200, summary([...byKey.values()], selected, safetyChecked));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/safety-check") {
        const checkedSessions = await options.onSafetyCheck?.([...byKey.values()]);
        if (checkedSessions) {
          const checkedByKey = new Map(checkedSessions.map((session) => [session.key, session]));
          if (
            checkedByKey.size !== byKey.size ||
            [...byKey.keys()].some((key) => !checkedByKey.has(key))
          ) {
            throw new Error("Safety check changed the preview session scope");
          }
          byKey = checkedByKey;
        }
        safetyChecked = true;
        json(response, 200, summary([...byKey.values()], selected, safetyChecked));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/approve") {
        if (!safetyChecked) {
          json(response, 409, { error: "Check and remove secrets before upload" });
          return;
        }
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

function summary(sessions: PreviewSession[], selected: Set<string>, safetyChecked: boolean) {
  const rows = sessions.map((session) => ({ ...session, selected: selected.has(session.key) }));
  const included = rows.filter((session) => session.selected);
  return {
    sessions: rows,
    safetyChecked,
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
*{box-sizing:border-box}:root{color:#171717;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif}body{margin:0}.page{max-width:900px;margin:0 auto;padding:48px 24px 140px}h1{font-size:30px;letter-spacing:-.03em;margin:0 0 8px}p{line-height:1.5}.lede{color:#666;margin:0 0 28px}.safe{background:#f1f8f4;border:1px solid #b7dfc5;padding:16px 18px;border-radius:12px;line-height:1.5}#summary{font-weight:600;margin:26px 0 8px}.session{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:12px;padding:16px 0;border-bottom:1px solid #e5e5e5}.session input{margin-top:3px}.meta{color:#666;font-size:13px}.sample{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f2f2;padding:11px 12px;border-radius:8px;margin-top:9px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}button{border:0;border-radius:9px;padding:12px 18px;font:600 15px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;cursor:pointer;white-space:nowrap}button:disabled{cursor:default;opacity:.5}.primary{background:#171717;color:#fff;min-width:202px}.primary:not(:disabled):hover{background:#303030}.cancel{background:#ececec;color:#171717}.cancel:not(:disabled):hover{background:#e2e2e2}#actions{position:fixed;z-index:10;left:0;right:0;bottom:0;background:rgba(255,255,255,.96);border-top:1px solid #d8d8d8;box-shadow:0 -10px 30px rgba(0,0,0,.06);backdrop-filter:blur(16px)}#action-inner{max-width:900px;margin:0 auto;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;gap:24px}.action-note{color:#666;font-size:13px}.buttons{display:flex;gap:10px}.complete{max-width:560px;margin:18vh auto;padding:0 24px;text-align:center}.complete-mark{display:grid;place-items:center;width:44px;height:44px;margin:0 auto 18px;border-radius:50%;background:#e7f5eb;color:#176b35;font-size:22px}@media(max-width:640px){.page{padding:32px 18px 176px}#action-inner{align-items:stretch;flex-direction:column;gap:10px;padding:12px 18px}.buttons{width:100%}.primary{flex:1}.cancel{min-width:92px}}
</style></head><body><div class="page"><h1>Review sessions before upload</h1>
<p class="lede">Choose exactly what this Drive can receive.</p>
<div class="safe"><strong>Local review only.</strong><br>
Dosu will not modify or delete local files. Detected credentials are removed from the selected session copies before upload.</div>
<p id="summary">Loading local preview…</p><main id="sessions"></main></div><div id="actions"><div id="action-inner"><div class="action-note" id="action-note" aria-live="polite">Nothing will be uploaded yet.</div><div class="buttons"><button class="primary" id="primary" type="button">Check &amp; Remove Secrets</button><button class="cancel" id="cancel" type="button">Cancel</button></div></div></div>
<script>
let data;let busy=false;let actionError='';const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const count=(n,label)=>n+' '+label+(n===1?'':'s');
async function request(path,options){const response=await fetch(path,options);const payload=await response.json();if(!response.ok)throw new Error(payload.error||'Request failed');return payload}
async function load(){data=await request('/api/preview');render()}
function render(){const t=data.totals;const parts=[count(t.selected,'session')+' selected'];if(data.safetyChecked){parts.push(count(t.records,'searchable record'));parts.push(count(t.redactions,'potential credential')+' removed')}parts.push(t.excluded+' excluded');document.querySelector('#summary').textContent=parts.join(' · ');document.querySelector('#sessions').innerHTML=data.sessions.map(s=>'<label class="session"><input type="checkbox" '+(s.selected?'checked':'')+' data-key="'+esc(s.key)+'"><div><strong>'+esc(s.title)+'</strong><div class="meta">'+esc(s.repository)+' · '+esc(s.harness)+' · '+esc(s.updated)+'</div>'+(data.safetyChecked&&s.sample?'<div class="sample">'+esc(s.sample)+'</div>':'')+'</div><span class="meta">'+(data.safetyChecked?count(s.records,'record'):'')+'</span></label>').join('');document.querySelectorAll('.session input').forEach(el=>el.onchange=select);renderActions()}
function renderActions(){const t=data.totals;const primary=document.querySelector('#primary');primary.textContent=busy?(data.safetyChecked?'Starting upload…':'Checking & removing…'):(data.safetyChecked?'Upload '+count(t.selected,'Session'):'Check & Remove Secrets');primary.disabled=busy||t.selected===0;document.querySelector('#cancel').disabled=busy;const checked=t.redactions===0?'No potential credentials detected.':count(t.redactions,'potential credential')+' removed.';document.querySelector('#action-note').textContent=actionError||(data.safetyChecked?checked+' Nothing has been uploaded.':'Nothing will be uploaded yet.')}
async function select(){const keys=[...document.querySelectorAll('.session input:checked')].map(el=>el.dataset.key);data=await request('/api/select',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keys})});actionError='';render()}
async function primaryAction(){busy=true;actionError='';renderActions();try{if(!data.safetyChecked){data=await request('/api/safety-check',{method:'POST'});busy=false;render();return}await request('/api/approve',{method:'POST'});document.body.innerHTML='<main class="complete"><div class="complete-mark">✓</div><h1>Upload started</h1><p>Return to the terminal to watch the Drive index finish.</p></main>'}catch(error){busy=false;actionError=error instanceof Error?error.message:'Could not continue. Try again.';renderActions()}}
document.querySelector('#primary').onclick=primaryAction;document.querySelector('#cancel').onclick=async()=>{await request('/api/cancel',{method:'POST'});document.body.innerHTML='<main class="complete"><h1>Setup cancelled</h1><p>Nothing was uploaded. You can close this tab.</p></main>'};load();
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
/* v8 ignore stop */
