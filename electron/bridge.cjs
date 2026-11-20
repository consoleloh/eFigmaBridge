'use strict';

// WebSocket-мост между LLM (через MCP-адаптер) и Figma-плагином.
// Портировано из FrontMultitool bridge/packages/mcp-server/src/bridge.ts:
// тот же диапазон портов, та же версия рукопожатия — плагин работает без изменений.
// Поверх handshake — маршрутизация RPC: запросы LLM-клиентов (mcp-request) уходят
// в прикреплённый плагин, ответы возвращаются исходному клиенту (mcp-response).

const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('node:crypto');

// SPEC 5.2.1: диапазон портов сессий и версия рукопожатия — те же значения в figma-plugin/src/ui.ts
const PORT_FIRST = 9323;
const PORT_LAST = 9325;
const PROTOCOL_VERSION = 2;
// Сокет, который не прошёл handshake за это время, отбрасывается
const HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 180_000;

// «eFigmaBridge · 10:42» — имя приложения и время запуска сессии
function defaultLabel(startedAt) {
  const hh = String(startedAt.getHours()).padStart(2, '0');
  const mm = String(startedAt.getMinutes()).padStart(2, '0');
  return `eFigmaBridge · ${hh}:${mm}`;
}

class BridgeHub {
  constructor({ portFirst = PORT_FIRST, portLast = PORT_LAST } = {}) {
    this.portFirst = portFirst;
    this.portLast = portLast;
    this.wss = null;
    this.port = null;
    this.pluginSocket = null;
    this.pluginFile = null;
    // Подключённые LLM-клиенты (MCP-адаптеры): id -> { id, client, pid, connectedAt, socket }
    this.clients = new Map();
    // Ожидающие ответа RPC: requestId -> { clientId, timer }
    this.pending = new Map();
    this.startedAt = new Date();
    this.label = defaultLabel(this.startedAt);
    this.labelSource = 'default';
    this.onChange = null; // колбэк для пуша состояния в UI
  }

  _changed() {
    if (this.onChange) this.onChange(this.state());
  }

  // Занимает первый свободный порт диапазона; занятый порт не роняет процесс
  start() {
    if (this.wss) return this.state();
    this._listen(this.portFirst);
    return this.state();
  }

  stop() {
    this._failAllPending('PLUGIN_NOT_CONNECTED', 'Мост остановлен');
    for (const client of this.clients.values()) {
      try { client.socket.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
    if (this.pluginSocket) {
      try { this.pluginSocket.close(); } catch { /* ignore */ }
      this.pluginSocket = null;
      this.pluginFile = null;
    }
    if (this.wss) {
      try { this.wss.close(); } catch { /* ignore */ }
      this.wss = null;
    }
    this.port = null;
    this._changed();
  }

  _listen(port) {
    // Только loopback: плагин и адаптеры на этой же машине
    const wss = new WebSocketServer({ port, host: 'localhost' });

    wss.on('listening', () => {
      this.wss = wss;
      this.port = port;
      this._changed();
    });

    wss.on('connection', (ws) => this._onConnection(ws));

    wss.on('error', (err) => {
      try { wss.close(); } catch { /* ignore */ }
      if (this.wss === wss) {
        this.wss = null;
        this.port = null;
      }
      if (err.code === 'EADDRINUSE' && port < this.portLast) {
        this._listen(port + 1);
        this._changed();
        return;
      }
      this.lastError = err.code === 'EADDRINUSE'
        ? `Порты ${this.portFirst}–${this.portLast} заняты: закройте лишние сессии.`
        : err.message;
      this._changed();
    });
  }

  info() {
    return {
      protocol: PROTOCOL_VERSION,
      port: this.port,
      label: this.label,
      labelSource: this.labelSource,
      projectDir: '',
      project: 'eFigmaBridge',
      startedAt: this.startedAt.toISOString(),
      env: 'desktop',
      busy: this._pluginConnected() ? this.pluginFile : null,
    };
  }

  // set_session_label: новая метка уходит и плагину, и всем LLM-клиентам
  setLabel(label) {
    this.label = label;
    this.labelSource = 'set';
    this._send(this.pluginSocket, { type: 'info', info: this.info() });
    for (const client of this.clients.values()) {
      this._send(client.socket, { type: 'mcp-info', info: this.info() });
    }
    this._changed();
    return this.info();
  }

  _pluginConnected() {
    return this.pluginSocket !== null && this.pluginSocket.readyState === WebSocket.OPEN;
  }

  _send(ws, msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // Handshake: сокет либо probe (узнать info, не занимая сервер), либо attach (плагин,
  // один на сервер), либо mcp-attach (LLM-адаптер, можно несколько)
  _onConnection(ws) {
    let role = null; // 'plugin' | 'llm'
    let clientId = null;
    const handshakeTimer = setTimeout(() => { if (!role) ws.close(); }, HANDSHAKE_TIMEOUT_MS);

    ws.on('message', (data) => {
      const raw = data.toString();

      if (role === 'plugin') {
        this._onPluginMessage(raw);
        return;
      }

      if (role === 'llm') {
        this._onLlmMessage(clientId, raw);
        return;
      }

      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'probe') {
        this._send(ws, { type: 'info', info: this.info() });
      } else if (msg.type === 'attach') {
        clearTimeout(handshakeTimer);
        if (this._pluginConnected()) {
          this._send(ws, { type: 'rejected', info: this.info() });
          ws.close();
          return;
        }
        role = 'plugin';
        this.pluginSocket = ws;
        this.pluginFile = msg.fileName;
        this._send(ws, { type: 'attached', info: this.info() });
        this._changed();
      } else if (msg.type === 'mcp-attach') {
        clearTimeout(handshakeTimer);
        role = 'llm';
        clientId = crypto.randomUUID();
        this.clients.set(clientId, {
          id: clientId,
          client: String(msg.client || 'LLM'),
          pid: typeof msg.pid === 'number' ? msg.pid : null,
          connectedAt: new Date().toISOString(),
          socket: ws,
        });
        this._send(ws, { type: 'mcp-attached', info: this.info() });
        this._changed();
      }
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      if (this.pluginSocket === ws) {
        this.pluginSocket = null;
        this.pluginFile = null;
        // Плагин ушёл — все ожидающие запросы падают с PLUGIN_NOT_CONNECTED
        this._failAllPending('PLUGIN_NOT_CONNECTED', 'Плагин отключился до ответа');
      }
      if (clientId && this.clients.has(clientId)) {
        this.clients.delete(clientId);
        // Ожидания ушедшего клиента чистим без ответа
        for (const [requestId, entry] of this.pending) {
          if (entry.clientId === clientId) {
            clearTimeout(entry.timer);
            this.pending.delete(requestId);
          }
        }
      }
      this._changed();
    });

    ws.on('error', () => { /* ошибки сокета придут и через close */ });
  }

  // Ответ плагина → исходный LLM-клиент
  _onPluginMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.requestId || !this.pending.has(msg.requestId)) return;

    const entry = this.pending.get(msg.requestId);
    clearTimeout(entry.timer);
    this.pending.delete(msg.requestId);

    const client = this.clients.get(entry.clientId);
    this._send(client?.socket ?? null, {
      type: 'mcp-response',
      requestId: msg.requestId,
      ok: !!msg.ok,
      result: msg.result,
      error: msg.error,
    });
  }

  // Запрос от LLM-клиента → прикреплённый плагин
  _onLlmMessage(clientId, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const client = this.clients.get(clientId);
    if (!client) return;

    if (msg.type === 'mcp-set-label') {
      this.setLabel(String(msg.label ?? '').slice(0, 80));
      return;
    }

    if (msg.type !== 'mcp-request' || !msg.requestId) return;

    if (!this._pluginConnected()) {
      this._send(client.socket, {
        type: 'mcp-response',
        requestId: msg.requestId,
        ok: false,
        error: {
          code: 'PLUGIN_NOT_CONNECTED',
          message: `Плагин не подключён к этой сессии: выберите «${this.label}» в окне плагина FrontMultitool Bridge ` +
            '(файл открыт в Figma Desktop, плагин запущен).',
        },
      });
      return;
    }

    const timeoutMs = Math.min(
      Number(msg.timeoutMs) > 0 ? Number(msg.timeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
    );
    const timer = setTimeout(() => {
      this.pending.delete(msg.requestId);
      this._send(client.socket, {
        type: 'mcp-response',
        requestId: msg.requestId,
        ok: false,
        error: { code: 'TIMEOUT', message: `Request "${msg.requestType}" timed out after ${timeoutMs} ms` },
      });
    }, timeoutMs);

    this.pending.set(msg.requestId, { clientId, timer });

    // Envelope RpcRequest — как в оригинальном WsBridge.request
    this.pluginSocket.send(JSON.stringify({
      type: msg.requestType,
      payload: msg.payload,
      requestId: msg.requestId,
    }));
  }

  _failAllPending(code, message) {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      const client = this.clients.get(entry.clientId);
      this._send(client?.socket ?? null, { type: 'mcp-response', requestId, ok: false, error: { code, message } });
      this.pending.delete(requestId);
    }
  }

  state() {
    return {
      running: this.port !== null,
      port: this.port,
      portRange: [this.portFirst, this.portLast],
      label: this.label,
      startedAt: this.startedAt.toISOString(),
      error: this.lastError || null,
      plugin: {
        connected: this._pluginConnected(),
        fileName: this._pluginConnected() ? this.pluginFile : null,
      },
      clients: Array.from(this.clients.values()).map(({ id, client, pid, connectedAt }) => ({
        id, client, pid, connectedAt,
      })),
    };
  }
}

module.exports = { BridgeHub, PORT_FIRST, PORT_LAST };
