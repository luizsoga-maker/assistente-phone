// Ponte entre o assistente do iPhone e o Claude Code no Mac.
//
// Escuta só em 127.0.0.1 e serve a própria página do assistente em
// http://localhost:8787, já com o token embutido. Opcionalmente, `tailscale serve`
// publica a porta dentro da sua rede privada para usar pelo iPhone.
//
// Regras de permissão:
// - leitura e edição de arquivos dentro do projeto: liberadas
// - .env, chaves e a pasta .git: sempre pedem confirmação
// - qualquer coisa fora do projeto, comandos de terminal e demais ferramentas:
//   pedem confirmação no iPhone (sem resposta em 5 minutos = negado)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// BRIDGE_SDK permite trocar o SDK por um simulado nos testes
const { query } = await import(process.env.BRIDGE_SDK || '@anthropic-ai/claude-agent-sdk');

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------- Configuração ----------
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(path.join(DIR, '.env'));

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.BRIDGE_TOKEN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://luizsoga-maker.github.io';
const MODEL = process.env.CLAUDE_MODEL || undefined;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
// Hosts aceitos (proteção contra DNS rebinding). Acrescente o nome do Tailscale se usar.
const ALLOWED_HOSTS = new Set(['localhost:' + PORT, '127.0.0.1:' + PORT,
  ...String(process.env.EXTRA_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)]);

if (TOKEN.length < 24) {
  console.error('Defina BRIDGE_TOKEN no bridge/.env (mínimo 24 caracteres). Gere com: openssl rand -hex 24');
  process.exit(1);
}

const projectsFile = path.join(DIR, 'projects.json');
if (!fs.existsSync(projectsFile)) {
  console.error('Crie bridge/projects.json (veja projects.example.json).');
  process.exit(1);
}
const PROJECTS = {};
for (const [name, dir] of Object.entries(JSON.parse(fs.readFileSync(projectsFile, 'utf8')))) {
  const real = fs.realpathSync(dir.replace(/^~(?=\/)/, process.env.HOME));
  PROJECTS[name] = real;
}

// ---------- Permissões ----------
const FILE_TOOLS = { Read:'file_path', Edit:'file_path', MultiEdit:'file_path', Write:'file_path',
  NotebookEdit:'notebook_path', Glob:'path', Grep:'path' };
const SAFE_TOOLS = new Set(['TodoWrite', 'WebSearch', 'WebFetch', 'Task', 'ExitPlanMode']);
const SENSITIVE = /(^|\/)(\.env[^/]*|\.git(\/|$)|id_[a-z0-9]+|[^/]*\.(pem|key|p12))$|(^|\/)\.git\//i;

function inside(root, p) {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  return { abs, ok: rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) };
}

function describe(tool, input) {
  if (tool === 'Bash') return 'rodar o comando: ' + String(input.command || '').slice(0, 300);
  const key = FILE_TOOLS[tool];
  if (key && input[key]) return tool + ' em ' + input[key];
  return tool + ' ' + JSON.stringify(input).slice(0, 200);
}

// ---------- Tarefas ----------
const tasks = new Map();          // id -> tarefa
const lastSession = {};           // projeto -> session_id para continuar a conversa

function publicTask(t) {
  return {
    id: t.id, project: t.project, prompt: t.prompt, status: t.status,
    startedAt: t.startedAt, endedAt: t.endedAt || null, log: t.log.slice(-8),
    approval: t.approval ? { id: t.approval.id, summary: t.approval.summary } : null,
    result: t.result || null, error: t.error || null, cost: t.cost ?? null
  };
}

function requestApproval(t, tool, input, signal) {
  return new Promise((resolve) => {
    const id = randomUUID();
    const done = (allow, why) => {
      clearTimeout(timer);
      if (t.approval && t.approval.id === id) t.approval = null;
      t.status = 'running';
      resolve(allow ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: why || 'O usuário negou pelo iPhone.' });
    };
    const timer = setTimeout(() => done(false, 'Sem resposta do usuário em 5 minutos.'), APPROVAL_TIMEOUT_MS);
    signal.addEventListener('abort', () => done(false, 'Tarefa cancelada.'), { once: true });
    t.approval = { id, summary: describe(tool, input), resolve: done };
    t.status = 'waiting_approval';
    t.log.push('aguardando confirmação: ' + t.approval.summary);
  });
}

function makeCanUseTool(t, root) {
  return async (tool, input, { signal }) => {
    const key = FILE_TOOLS[tool];
    if (key) {
      const target = input[key] || root;
      const { abs, ok } = inside(root, target);
      if (ok && !SENSITIVE.test(abs)) return { behavior: 'allow', updatedInput: input };
      return requestApproval(t, tool, input, signal);
    }
    if (SAFE_TOOLS.has(tool)) return { behavior: 'allow', updatedInput: input };
    return requestApproval(t, tool, input, signal);
  };
}

const APPEND = [
  'Você está recebendo pedidos por voz, vindos de um assistente no iPhone do usuário.',
  'Não faça git push, deploy nem apague arquivos a menos que o pedido diga isso explicitamente.',
  'Ao terminar, encerre com um resumo de no máximo 3 frases em português do Brasil, sem markdown,',
  'listas ou blocos de código, próprio para ser lido em voz alta.'
].join(' ');

async function runTask(t, newSession) {
  const root = PROJECTS[t.project];
  const resume = !newSession && lastSession[t.project] ? lastSession[t.project] : undefined;
  try {
    const q = query({
      prompt: t.prompt,
      options: {
        cwd: root,
        resume,
        model: MODEL,
        permissionMode: 'default',
        canUseTool: makeCanUseTool(t, root),
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: APPEND },
        maxTurns: 40,
        abortController: t.abort
      }
    });
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const b of msg.message.content || []) {
          if (b.type === 'tool_use') t.log.push(describe(b.name, b.input || {}));
        }
        if (t.log.length > 50) t.log.splice(0, t.log.length - 50);
      } else if (msg.type === 'result') {
        if (msg.session_id) lastSession[t.project] = msg.session_id;
        t.cost = msg.total_cost_usd;
        if (msg.subtype === 'success' && !msg.is_error) t.result = msg.result;
        else t.error = msg.subtype === 'success' ? msg.result : 'Parou antes de terminar (' + msg.subtype + ').';
      }
    }
    t.status = t.error ? 'error' : 'done';
  } catch (e) {
    t.status = t.abort.signal.aborted ? 'cancelled' : 'error';
    t.error = t.abort.signal.aborted ? 'Tarefa cancelada.' : String(e.message || e);
  }
  t.approval = null;
  t.endedAt = Date.now();
  console.log(`[${t.id.slice(0, 8)}] ${t.status} (${t.project}) ${t.cost != null ? '$' + t.cost.toFixed(3) : ''}`);
}

// ---------- HTTP ----------
function send(res, code, body, origin) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (origin === ALLOWED_ORIGIN) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'Origin';
  }
  res.writeHead(code, headers);
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function authorized(req) {
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('corpo grande demais')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!ALLOWED_HOSTS.has(String(req.headers.host || ''))) {
    res.writeHead(421); return res.end();
  }
  if (req.method === 'OPTIONS') {
    if (origin !== ALLOWED_ORIGIN) return send(res, 403, { error: 'origem não permitida' });
    res.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '600',
      'vary': 'Origin'
    });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');

  // Página do assistente (mesma origem: dispensa CORS e configuração de token).
  // Outros sites abertos no navegador não conseguem ler esta resposta (sem CORS).
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(DIR, '..', 'index.html'), 'utf8')
      .replace('<head>', '<head>\n<meta name="bridge-token" content="' + TOKEN + '">');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'GET' && url.pathname === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/manifest+json' });
    return res.end(fs.readFileSync(path.join(DIR, '..', 'manifest.json')));
  }

  if (!authorized(req)) return send(res, 401, { error: 'token inválido' }, origin);

  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, projects: Object.keys(PROJECTS) }, origin);
    }
    // Conversa do assistente: repassa para a API usando a chave do .env (fica fora do navegador)
    if (req.method === 'POST' && url.pathname === '/messages') {
      if (!process.env.ANTHROPIC_API_KEY) return send(res, 500, { error: { message: 'ANTHROPIC_API_KEY não definida no bridge/.env' } }, origin);
      const body = await readBody(req, 8 * 1024 * 1024);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      });
      return send(res, r.status, await r.json(), origin);
    }
    if (req.method === 'POST' && url.pathname === '/tasks') {
      const body = await readBody(req);
      const project = String(body.project || '');
      const prompt = String(body.task || '').trim();
      if (!PROJECTS[project]) return send(res, 400, { error: 'projeto desconhecido', projects: Object.keys(PROJECTS) }, origin);
      if (!prompt) return send(res, 400, { error: 'tarefa vazia' }, origin);
      const busy = [...tasks.values()].find((x) => x.project === project && (x.status === 'running' || x.status === 'waiting_approval'));
      if (busy) return send(res, 409, { error: 'já existe uma tarefa rodando neste projeto', id: busy.id }, origin);
      const t = { id: randomUUID(), project, prompt, status: 'running', startedAt: Date.now(), log: [], abort: new AbortController() };
      tasks.set(t.id, t);
      if (tasks.size > 30) tasks.delete(tasks.keys().next().value);
      console.log(`[${t.id.slice(0, 8)}] nova tarefa em ${project}: ${prompt.slice(0, 120)}`);
      runTask(t, !!body.new_session);
      return send(res, 201, publicTask(t), origin);
    }
    if (parts[0] === 'tasks' && parts[1]) {
      const t = tasks.get(parts[1]);
      if (!t) return send(res, 404, { error: 'tarefa não encontrada' }, origin);
      if (req.method === 'GET' && parts.length === 2) return send(res, 200, publicTask(t), origin);
      if (req.method === 'POST' && parts[2] === 'approve') {
        const body = await readBody(req);
        if (!t.approval || t.approval.id !== body.approvalId) return send(res, 409, { error: 'nada aguardando confirmação' }, origin);
        console.log(`[${t.id.slice(0, 8)}] ${body.allow ? 'permitido' : 'negado'}: ${t.approval.summary}`);
        t.approval.resolve(!!body.allow);
        return send(res, 200, publicTask(t), origin);
      }
      if (req.method === 'POST' && parts[2] === 'cancel') {
        t.abort.abort();
        return send(res, 200, publicTask(t), origin);
      }
    }
    send(res, 404, { error: 'rota não encontrada' }, origin);
  } catch (e) {
    send(res, 400, { error: String(e.message || e) }, origin);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Ponte do Claude Code em http://127.0.0.1:${PORT}`);
  console.log('Projetos:', Object.entries(PROJECTS).map(([n, d]) => `${n} -> ${d}`).join(', '));
  console.log(`Abra no navegador do Mac: http://localhost:${PORT}`);
});
