#!/usr/bin/env node
// eFigmaBridge — stdio MCP-адаптер для LLM с полным набором tools (54).
//
// LLM запускает этот скрипт как MCP-сервер через свой конфиг:
//   { "command": "node", "args": ["<путь>/mcp-stdio.mjs", "--port", "9323", "--client", "cursor"] }
//
// Адаптер:
//   1. Говорит MCP JSON-RPC по stdio (initialize / tools/list / tools/call / ping).
//   2. Держит WebSocket-подключение к десктопному приложению eFigmaBridge и проксирует
//      вызовы tools через него в Figma-плагин (переподключение каждые 2 с).
//
// ВАЖНО: весь лог — только в stderr, stdout принадлежит MCP-протоколу.
// Требуется Node.js >= 22 (встроенный клиент WebSocket).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const RECONNECT_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 5_000;

function parseArgs(argv) {
  const args = { port: null, client: 'LLM' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--client') args.client = argv[++i];
  }
  return args;
}

const { port, client } = parseArgs(process.argv.slice(2));
if (!port || !Number.isInteger(port)) {
  console.error('[efigmabridge] usage: node mcp-stdio.mjs --port <9323-9325> [--client <name>]');
  process.exit(1);
}

// Определения tools — извлечены из оригинального mcp-server (scripts/extract-tools.mjs)
const TOOLS = JSON.parse(
  readFileSync(fileURLToPath(new URL('./tools.json', import.meta.url)), 'utf8'),
);
const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Состояние сессии: info приходит от приложения при подключении и смене метки
// ---------------------------------------------------------------------------

let sessionInfo = null; // SessionInfo, как в shared/bridge (port, label, labelSource, env, projectDir)

// ---------------------------------------------------------------------------
// WebSocket к десктопному приложению + корреляция запросов
// ---------------------------------------------------------------------------

let ws = null;
let wsOpen = false;
const pending = new Map(); // requestId -> { resolve, timer }

function connect() {
  let socket;
  try {
    socket = new WebSocket(`ws://localhost:${port}`);
  } catch {
    setTimeout(connect, RECONNECT_MS);
    return;
  }
  ws = socket;

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'mcp-attach', client, pid: process.pid }));
  };

  socket.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'mcp-attached' || msg.type === 'mcp-info') {
      const wasOpen = wsOpen;
      wsOpen = true;
      sessionInfo = msg.info;
      if (!wasOpen) {
        console.error(`[efigmabridge] connected to desktop app on port ${port} as «${client}»`);
      }
      return;
    }

    if (msg.type === 'mcp-response' && pending.has(msg.requestId)) {
      const entry = pending.get(msg.requestId);
      pending.delete(msg.requestId);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  };

  socket.onclose = () => {
    wsOpen = false;
    sessionInfo = null;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        type: 'mcp-response', requestId: id, ok: false,
        error: { code: 'PLUGIN_NOT_CONNECTED', message: 'Приложение eFigmaBridge закрыло соединение. Запустите мост и повторите.' },
      });
    }
    pending.clear();
    console.error('[efigmabridge] connection lost — retrying…');
    setTimeout(connect, RECONNECT_MS);
  };

  socket.onerror = () => {
    try { socket.close(); } catch { /* onclose сделает переподключение */ }
  };
}

// Запрос к Figma-плагину через приложение. Резолвит { ok, result } или { ok: false, error }
async function bridgeRequest(requestType, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!(await ensureOpen(2_000))) {
    return {
      ok: false,
      error: {
        code: 'PLUGIN_NOT_CONNECTED',
        message: 'Нет связи с приложением eFigmaBridge: запустите его и нажмите «Запустить мост».',
      },
    };
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolvePromise({
        ok: false,
        error: { code: 'TIMEOUT', message: `Request "${requestType}" timed out after ${timeoutMs} ms` },
      });
    }, timeoutMs + 1_000); // запас над таймаутом приложения
    pending.set(requestId, { resolve: resolvePromise, timer });
    ws.send(JSON.stringify({ type: 'mcp-request', requestId, requestType, payload, timeoutMs }));
  });
}

// Подключение может ещё устанавливаться (LLM дёргает tool сразу после запуска адаптера)
function ensureOpen(graceMs) {
  if (wsOpen && ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const start = Date.now();
    const poll = () => {
      if (wsOpen && ws && ws.readyState === WebSocket.OPEN) return resolvePromise(true);
      if (Date.now() - start >= graceMs) return resolvePromise(false);
      setTimeout(poll, 50);
    };
    poll();
  });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const errorResult = (error) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] });

function toCallResult(response) {
  if (response.ok) return textResult(response.result);
  return errorResult(response.error ?? { code: 'FIGMA_ERROR', message: 'Plugin returned an error without details' });
}

function serverInfoBlock() {
  const info = sessionInfo ?? {};
  return {
    listening: true,
    port: info.port ?? port,
    label: info.label ?? null,
    labelSource: info.labelSource ?? 'default',
    env: info.env ?? 'desktop',
    projectDir: info.projectDir ?? '',
  };
}

// ---------------------------------------------------------------------------
// Выполнение tools по kind (как в оригинальном mcp-server, без zod)
// ---------------------------------------------------------------------------

async function callTool(name, args = {}) {
  const tool = toolByName.get(name);
  if (!tool) {
    return errorResult({ code: 'UNKNOWN_REQUEST', message: `Unknown tool "${name}"` });
  }

  switch (tool.kind) {
    case 'status': {
      const server = serverInfoBlock();
      const response = await bridgeRequest('get_status', {}, STATUS_TIMEOUT_MS);
      if (response.ok) {
        return textResult({
          server,
          plugin: { connected: true },
          file: { name: response.result?.fileName },
        });
      }
      return errorResult({ ...(response.error ?? {}), server });
    }

    case 'label': {
      const label = String(args.label ?? '').trim();
      if (!label || label.length > 80) {
        return errorResult({ code: 'INVALID_ARGUMENT', message: 'label: непустая строка до 80 символов' });
      }
      if (!(await ensureOpen(2_000))) {
        return errorResult({ code: 'PLUGIN_NOT_CONNECTED', message: 'Нет связи с приложением eFigmaBridge.' });
      }
      ws.send(JSON.stringify({ type: 'mcp-set-label', label }));
      // Приложение ответит mcp-info; вернём то, что знаем сейчас
      return textResult({ port, label, labelSource: 'set' });
    }

    case 'plain':
      return toCallResult(await bridgeRequest(name, args, tool.timeoutMs));

    case 'toFile': {
      const { outFile, ...payload } = args;
      const response = await bridgeRequest(name, payload, tool.timeoutMs);
      if (!response.ok) return toCallResult(response);
      if (!outFile) return textResult(response.result);
      const savedTo = resolve(String(outFile));
      try {
        mkdirSync(dirname(savedTo), { recursive: true });
        writeFileSync(savedTo, JSON.stringify(response.result, null, 2));
      } catch (err) {
        return errorResult({ code: 'INVALID_ARGUMENT', message: `Cannot write ${savedTo}: ${err.message}` });
      }
      const count = Array.isArray(response.result) ? response.result.length : undefined;
      return textResult({ savedTo, count });
    }

    case 'dataFile': {
      const { outFile, ...payload } = args;
      if (!outFile) {
        return errorResult({ code: 'INVALID_ARGUMENT', message: 'outFile: обязательный аргумент' });
      }
      const response = await bridgeRequest(name, payload, tool.timeoutMs);
      if (!response.ok) return toCallResult(response);
      const { data, ...info } = response.result ?? {};
      const savedTo = resolve(String(outFile));
      const content = Buffer.from(String(data ?? ''), tool.encoding ?? 'utf8');
      try {
        mkdirSync(dirname(savedTo), { recursive: true });
        writeFileSync(savedTo, content);
      } catch (err) {
        return errorResult({ code: 'INVALID_ARGUMENT', message: `Cannot write ${savedTo}: ${err.message}` });
      }
      return textResult({ savedTo, bytes: content.length, ...info });
    }

    case 'uploadBinary': {
      const { file, ...payload } = args;
      let bytesBase64;
      try {
        bytesBase64 = readFileSync(resolve(String(file))).toString('base64');
      } catch (err) {
        return errorResult({ code: 'INVALID_ARGUMENT', message: `Cannot read ${resolve(String(file))}: ${err.message}` });
      }
      return toCallResult(await bridgeRequest(name, { ...payload, bytesBase64 }, tool.timeoutMs));
    }

    case 'uploadText': {
      const { file, ...payload } = args;
      let svg;
      try {
        svg = readFileSync(resolve(String(file)), 'utf8');
      } catch (err) {
        return errorResult({ code: 'INVALID_ARGUMENT', message: `Cannot read ${resolve(String(file))}: ${err.message}` });
      }
      return toCallResult(await bridgeRequest(name, { ...payload, svg }, tool.timeoutMs));
    }

    case 'batch':
      return runBatch(args);

    default:
      return errorResult({ code: 'UNKNOWN_REQUEST', message: `Tool "${name}" has unknown kind "${tool.kind}"` });
  }
}

// ---------------------------------------------------------------------------
// run_batch: список вызовов других tools из JSON-файла, с placeholder-сохранением
// ---------------------------------------------------------------------------

function pick(value, path) {
  return path.split('.').reduce((node, part) => {
    const match = /^(\w+)\[(\d+)\]$/.exec(part);
    if (match) return node?.[match[1]]?.[Number(match[2])];
    return node?.[part];
  }, value);
}

function substitute(value, saved, declared) {
  if (typeof value === 'string' && declared.has(value)) {
    if (!saved.has(value)) {
      throw Object.assign(new Error(`Placeholder ${value} is used before the step that saves it`), { code: 'INVALID_ARGUMENT' });
    }
    return saved.get(value);
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, saved, declared));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      String(substitute(k, saved, declared)),
      substitute(v, saved, declared),
    ]));
  }
  return value;
}

const bodyOf = (result) => {
  const text = result.content.find((c) => c.type === 'text');
  try { return text ? JSON.parse(text.text) : {}; } catch { return {}; }
};

async function runBatch({ file, outFile }) {
  const invalid = (message) => errorResult({ code: 'INVALID_ARGUMENT', message });

  let ops;
  try {
    const data = JSON.parse(readFileSync(resolve(String(file)), 'utf8').replace(/^﻿/, ''));
    ops = Array.isArray(data) ? data : data.ops;
    if (!Array.isArray(ops)) throw new Error('no "ops" array');
  } catch (err) {
    return invalid(`Cannot read batch ${resolve(String(file))}: ${err.message}`);
  }

  // Проверка всех шагов до первого вызова (без zod — только наличие tool и обязательных полей)
  const declared = new Set(ops.flatMap((op) => Object.keys(op.saves ?? {})));
  for (const [i, op] of ops.entries()) {
    const tool = toolByName.get(op.tool);
    if (!tool || op.tool === 'run_batch') return invalid(`Step ${op.step ?? i + 1}: unknown tool "${op.tool}"`);
    const required = tool.inputSchema?.required ?? [];
    for (const field of required) {
      const value = (op.args ?? {})[field];
      if (value === undefined && !declared.has(value)) {
        return invalid(`Step ${op.step ?? i + 1} (${op.tool}): ${field}: Required`);
      }
    }
  }

  const saved = new Map();
  const log = [];
  const writeLog = () => {
    if (!outFile) return;
    mkdirSync(dirname(resolve(String(outFile))), { recursive: true });
    writeFileSync(resolve(String(outFile)), JSON.stringify(log, null, 2));
  };

  for (const [i, op] of ops.entries()) {
    const step = op.step ?? i + 1;
    let result;
    try {
      result = await callTool(op.tool, substitute(op.args ?? {}, saved, declared));
    } catch (err) {
      result = errorResult({ code: err.code ?? 'FIGMA_ERROR', message: err.message });
    }
    const body = bodyOf(result);
    log.push({ step, tool: op.tool, label: op.label, ok: !result.isError, result: body });

    let failure = result.isError ? { code: String(body.code ?? 'FIGMA_ERROR'), message: String(body.message ?? '') } : null;
    if (!failure) {
      for (const [name, path] of Object.entries(op.saves ?? {})) {
        const value = pick(body, path);
        if (value === undefined) {
          failure = { code: 'INVALID_ARGUMENT', message: `No "${path}" in the result to save as ${name}` };
          break;
        }
        saved.set(name, value);
      }
    }
    if (failure) {
      writeLog();
      const where = `Step ${step} (${op.tool}${op.label ? `: ${op.label}` : ''})`;
      return errorResult({ ...failure, message: `${where}: ${failure.message}`, step, done: i, total: ops.length });
    }
  }
  writeLog();
  return textResult({ done: ops.length, total: ops.length, savedTo: outFile ? resolve(String(outFile)) : undefined });
}

// ---------------------------------------------------------------------------
// MCP поверх stdio: newline-delimited JSON-RPC 2.0
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: 'efigmabridge-desktop', version: '0.2.0' };

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return;

  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

  switch (msg.method) {
    case 'initialize':
      reply({
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      break;
    case 'ping':
      reply({});
      break;
    case 'tools/list':
      reply({
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      });
      break;
    case 'tools/call':
      try {
        reply(await callTool(msg.params?.name, msg.params?.arguments ?? {}));
      } catch (err) {
        reply(errorResult({ code: 'FIGMA_ERROR', message: err.message }));
      }
      break;
    default:
      fail(-32601, `Method not found: ${msg.method}`);
  }
}

connect();
console.error(`[efigmabridge] MCP adapter ready (stdio), client «${client}», target port ${port}, ${TOOLS.length} tools`);
