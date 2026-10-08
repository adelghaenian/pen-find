#!/usr/bin/env node
// pen-find: find frames and components in a Pen (pen.dev) design file by meaning, using Jev
// (TypeSafe's fast judgment model). It reads the file through Pen's own MCP server, so the
// node list never enters your coding agent's context: only the top matches come back.
//
//   pen-find install                    # install as a Claude Code skill, then asks for your Jev key
//   pen-find setup                      # paste your Jev key (hidden), saved to ~/.pen-find/config.json
//   pen-find "the shelf empty state, dark mode"   [--file x.pen] [--top 5] [--deep] [--shot DIR] [--json]
//   pen-find index [--file x.pen]       # (re)build the cached node index
//   pen-find status
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME = process.env.PEN_FIND_HOME || path.join(os.homedir(), '.pen-find');
const CONFIG = path.join(HOME, 'config.json');
const API = (process.env.PEN_FIND_API_BASE || 'https://api.typesafe.ai').replace(/\/$/, '');
const KEY_URL = 'https://console.typesafe.ai';
const PEN_MCP = process.env.PEN_MCP_BIN || '/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64';

const die = (msg, code = 1) => { process.stderr.write(`pen-find: ${msg}\n`); process.exit(code); };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (['deep', 'json', 'help', 'refresh'].includes(k)) flags[k] = true;
    else flags[k] = argv[++i];
  }
  return { pos, flags };
}

// ---------- key ----------

function apiKey() {
  return process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || readJson(CONFIG, {}).api_key
    || readJson(path.join(os.homedir(), '.quicksilver/config.json'), {}).api_key || '';
}

async function promptHidden(q) {
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8').trim();
  process.stderr.write(q);
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', function onData(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData);
          process.stderr.write('\n'); return resolve(s);
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') s = s.slice(0, -1); else s += c;
      }
    });
  });
}

async function cmdSetup() {
  // Hidden input or stdin only: a key on the command line would land in shell history.
  const key = (await promptHidden(`Paste your Jev API key (get one at ${KEY_URL}; input is hidden): `)).trim();
  if (!key) die(`no key given. Get one at ${KEY_URL}`);
  const res = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${key}` } }).catch((e) => die(`network error: ${e.message}`));
  if (res.status === 401 || res.status === 403) die(`Jev rejected that key (${res.status}). Check it at ${KEY_URL}`, 3);
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG, JSON.stringify({ ...readJson(CONFIG, {}), api_key: key }, null, 2), { mode: 0o600 });
  fs.chmodSync(CONFIG, 0o600);
  console.log(`saved to ${CONFIG} (only you can read it). Try: pen-find "settings screen"`);
}

// ---------- secret guard: nothing key-like ever leaves the machine ----------

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD)\s*[=:]\s*["']?[A-Za-z0-9_\-:.\/+]{12,}/,
  /\b(sk-[A-Za-z0-9_\-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|apikey_[A-Za-z0-9_\-]{20,})\b/,
  /\bBearer\s+[A-Za-z0-9_\-.=]{20,}/,
];
function scrub(text, key) {
  let t = key ? text.split(key).join('[redacted]') : text;
  for (const re of SECRET_PATTERNS) t = t.replace(new RegExp(re.source, 'g'), '[redacted]');
  return t;
}

// ---------- Jev ----------

async function jev(body) {
  const key = apiKey();
  if (!key) die(`no Jev API key. Run: pen-find setup   (key from ${KEY_URL})`, 3);
  for (let attempt = 0; attempt <= 5; attempt++) {
    const res = await fetch(API + '/v1/systemone', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    if (res?.ok) return res.json();
    if (res && (res.status === 401 || res.status === 403)) die(`Jev rejected the key (${res.status}). Run: pen-find setup`, 3);
    if (res && (res.status === 400 || res.status === 422)) die(`Jev rejected the request: ${(await res.text()).slice(0, 400)}`, 4);
    await sleep(Number(res?.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt);
  }
  die('Jev request failed after retries', 5);
}

async function pool(tasks, n) {
  const out = new Array(tasks.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  }));
  return out;
}

const LEVELS = [
  'Unrelated to the query',
  'Shares a topic with the query but is not what it asks for',
  'Partially matches: a related screen or part of the right screen',
  'Matches most of the query',
  'Exactly the screen, frame or component the query describes',
];

async function rank(query, items) {
  const key = apiKey();
  const groups = [];
  for (let i = 0; i < items.length; i += 20) groups.push(items.slice(i, i + 20));
  let tokens = 0;
  const rows = (await pool(groups.map((g) => async () => {
    const state = { query, items: Object.fromEntries(g.map((it, j) => [`i${j}`, scrub(describe(it), key)])) };
    const questions = Object.fromEntries(g.map((_, j) => [`q${j}`, {
      type: 'score', criteria: LEVELS,
      instructions: { question: `How well does the design node \`items.i${j}\` match \`query\`? Judge only that item; ignore the others.` },
    }]));
    const res = await jev({ model: readJson(CONFIG, {}).model || 'jev-latest', state, questions });
    tokens += res.usage?.input_tokens || 0;
    return g.map((it, j) => ({ it, s: res.answers[`q${j}`]?.score ?? 0, c: res.answers[`q${j}`]?.confidence ?? 0 }));
  }), 16)).flat();
  rows.sort((a, b) => b.s - a.s || b.c - a.c || a.it.d - b.it.d);
  return { rows, tokens };
}

const describe = (it) => `${it.n || '(unnamed)'} — ${it.k}, ${it.w}×${it.h}. Inside: ${it.p || '(top level)'}.${it.t ? ` Text: ${it.t}` : ''}`;

// ---------- Pen MCP ----------

async function pen() {
  if (!fs.existsSync(PEN_MCP)) die(`Pen's MCP server not found at ${PEN_MCP}. Install Pen (pen.dev) or set PEN_MCP_BIN.`);
  const p = spawn(PEN_MCP, ['--app', 'desktop', '--agent', 'claudeCodeCLI'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', id = 0; const wait = {};
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      if (m.id && wait[m.id]) { wait[m.id](m); delete wait[m.id]; }
    }
  });
  p.on('exit', () => Object.values(wait).forEach((r) => r({ error: { message: 'Pen MCP server exited (is the Pen app open?)' } })));
  const rpc = (method, params) => new Promise((r) => { const i = ++id; wait[i] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const init = await Promise.race([rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pen-find', version: '0.1.0' } }), sleep(15000).then(() => null)]);
  if (!init?.result) die('could not reach Pen. Open the Pen app and try again.');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const call = async (name, args, { soft } = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const text = (r.result?.content || []).map((c) => c.text || '').join('');
    if (r.error || r.result?.isError || /Failure during operation/.test(text)) {
      if (soft) return null;
      die(`Pen: ${r.error?.message || text.slice(0, 400)}`);
    }
    return text;
  };
  return { call, close: () => p.kill() };
}

// The file open in Pen, else the last file pen-find used (Pen can't report it while another client is busy).
async function activeFile(p) {
  const m = (await p.call('get_app_state', {}, { soft: true }))?.match(/active canvas editor: `([^`]+\.pen)`/);
  const cfg = readJson(CONFIG, {});
  if (m) {
    if (cfg.last_file !== m[1]) { fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); fs.writeFileSync(CONFIG, JSON.stringify({ ...cfg, last_file: m[1] }, null, 2), { mode: 0o600 }); }
    return m[1];
  }
  if (cfg.last_file && fs.existsSync(cfg.last_file)) { process.stderr.write(`pen-find: Pen didn't say which file is open; using ${cfg.last_file}\n`); return cfg.last_file; }
  die('no .pen file is open in Pen. Open one or pass --file <path.pen>.');
}

// Runs inside Pen: one JSON line per frame / group / instance, with its path and the text inside it.
const INDEX_JS = `const items={},comps={};
Get(n=>{if(n.reusable)comps[n.id]=n.name});
Get((n,c)=>{
  const anc=[];let p=c.parentCtx;while(p){anc.unshift(p.node);p=p.parentCtx;}
  if(n.type==="text"&&n.content){const s=String(n.content);for(const a of anc){const it=items[a.id];if(it&&it.t.length<400)it.t+=(it.t?" · ":"")+s.slice(0,80);}return;}
  if(!["frame","group","ref"].includes(n.type))return;
  items[n.id]={id:n.id,d:c.depth,p:anc.map(a=>a.name||a.type).join(" › "),n:n.name||"",k:n.type==="ref"?"instance of "+(comps[n.ref]||"a component"):(n.reusable?"component":n.type),w:Math.round(c.bounds.width),h:Math.round(c.bounds.height),t:""};
});
for(const v of Object.values(items))Print(JSON.stringify(v));`;

function cachePath(file) {
  const h = crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 12);
  return path.join(HOME, 'index', `${path.basename(file, '.pen')}-${h}.jsonl`);
}

async function loadIndex(p, file, refresh) {
  const cache = cachePath(file);
  const fresh = fs.existsSync(cache) && fs.statSync(cache).mtimeMs > fs.statSync(file).mtimeMs;
  if (fresh && !refresh) return fs.readFileSync(cache, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const out = await p.call('execute', { filePath: file, input: INDEX_JS });
  const items = out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cache, items.map((i) => JSON.stringify(i)).join('\n'), { mode: 0o600 });
  return items;
}

// ---------- commands ----------

async function cmdFind(query, flags) {
  const t0 = Date.now();
  const p = await pen();
  try {
    const file = path.resolve(flags.file || await activeFile(p));
    if (!fs.existsSync(file)) die(`no such file: ${file}`);
    const all = await loadIndex(p, file, flags.refresh);
    const items = flags.deep ? all : all.filter((i) => i.d <= 4 || i.k === 'component');
    const { rows, tokens } = await rank(query, items);
    const top = rows.slice(0, Number(flags.top) || 5);
    if (flags.shot) {
      fs.mkdirSync(flags.shot, { recursive: true });
      await p.call('execute', { filePath: file, input: `Export(${JSON.stringify(top.map((r) => r.it.id))},"png",${JSON.stringify(path.resolve(flags.shot))},{scale:1})` });
    }
    const max = LEVELS.length - 1;
    if (flags.json) console.log(JSON.stringify({ file, matches: top.map((r) => ({ id: r.it.id, name: r.it.n, path: r.it.p, kind: r.it.k, size: [r.it.w, r.it.h], score: r.s / max, confidence: r.c })) }, null, 2));
    else for (const r of top) console.log(`${(r.s / max).toFixed(2)}  ${r.it.id}  ${r.it.p ? r.it.p + ' › ' : ''}${r.it.n}  (${r.it.k}, ${r.it.w}×${r.it.h})`);
    process.stderr.write(`— ${items.length} nodes judged · ${((Date.now() - t0) / 1000).toFixed(1)}s · jev ${(tokens / 1000).toFixed(1)}k tok ($${(tokens * 0.042 / 1e6).toFixed(4)})${flags.shot ? ` · screenshots in ${flags.shot}` : ''}\n`);
  } finally { p.close(); }
}

async function cmdInstall() {
  const here = path.dirname(new URL(import.meta.url).pathname); // skills/pen-find/scripts
  const dest = path.join(os.homedir(), '.claude/skills/pen-find');
  fs.mkdirSync(path.join(dest, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(here, '..', 'SKILL.md'), path.join(dest, 'SKILL.md'));
  fs.copyFileSync(path.join(here, 'pen-find.mjs'), path.join(dest, 'scripts/pen-find.mjs'));
  fs.chmodSync(path.join(dest, 'scripts/pen-find.mjs'), 0o755);
  console.log(`pen-find skill installed → ${dest}`);
  if (apiKey()) console.log('Jev key found. Restart Claude Code (or start a new session) and ask it to find a frame in your .pen file.');
  else if (process.stdin.isTTY) await cmdSetup();
  else console.log(`Next: set your Jev key → node ${dest}/scripts/pen-find.mjs setup   (key from ${KEY_URL})`);
}

const HELP = `pen-find: find frames and components in a Pen design file by meaning (Jev).
  pen-find install               install as a Claude Code skill (asks for your key)
  pen-find setup                 paste your Jev API key (hidden input)
  pen-find "<what you want>"     [--file x.pen] [--top 5] [--deep] [--shot DIR] [--json] [--refresh]
  pen-find index [--file x.pen]  rebuild the cached node index
  pen-find status                key and Pen check`;

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos[0];
if (!cmd || flags.help) { console.log(HELP); process.exit(cmd ? 0 : 2); }
if (cmd === 'setup') await cmdSetup();
else if (cmd === 'install') await cmdInstall();
else if (cmd === 'status') {
  console.log(apiKey() ? 'key: set' : `key: missing (run pen-find setup; get one at ${KEY_URL})`);
  const p = await pen(); try { console.log(`pen: open, active file ${await activeFile(p)}`); } finally { p.close(); }
} else if (cmd === 'index') {
  const p = await pen();
  try { const f = path.resolve(flags.file || await activeFile(p)); console.log(`${(await loadIndex(p, f, true)).length} nodes indexed from ${f}`); } finally { p.close(); }
} else await cmdFind(pos.join(' '), flags);
