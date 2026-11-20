// Smoke-тест связки: BridgeHub + имитатор Figma-плагина + MCP-адаптер с tools.
// Запуск: node scripts/smoke-test.mjs   (из корня проекта, без Electron)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { BridgeHub } = require('../electron/bridge.cjs');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adapterPath = path.join(root, 'adapter', 'mcp-stdio.mjs');
const toolsCount = JSON.parse(readFileSync(path.join(root, 'adapter', 'tools.json'), 'utf8')).length;

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + String(extra).slice(0, 200) : ''}`);
  if (!ok) failures++;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Запуск моста
const hub = new BridgeHub({ portFirst: 9410, portLast: 9412 });
let lastState = null;
hub.onChange = (s) => { lastState = s; };
hub.start();
await wait(500);

check('мост занял порт 9410', lastState?.port === 9410, `port=${lastState?.port}`);

// 2. Имитатор плагина: отвечает на RPC по правилам
//    get_status → {fileName}; create_frame → эхо payload с id; unknown → UNKNOWN_REQUEST
const plugin = await new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://localhost:9410');
  const timer = setTimeout(() => reject(new Error('attach timeout')), 1500);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'attach', fileName: 'SmokeTest.fig' }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'attached') { clearTimeout(timer); resolve(ws); return; }
    if (!msg.requestId) return; // info при смене метки
    if (msg.type === 'get_status') {
      ws.send(JSON.stringify({ type: 'get_status', requestId: msg.requestId, ok: true, result: { fileName: 'SmokeTest.fig' } }));
    } else if (msg.type === 'create_frame') {
      ws.send(JSON.stringify({
        type: 'create_frame', requestId: msg.requestId, ok: true,
        result: { id: '10:1', name: msg.payload.name, parentId: msg.payload.parentId },
      }));
    } else if (msg.type === 'set_frame_layout') {
      ws.send(JSON.stringify({
        type: 'set_frame_layout', requestId: msg.requestId, ok: true,
        result: { id: msg.payload.id, name: 'Card', type: 'FRAME', width: 320, height: 200 },
      }));
    } else if (msg.type === 'create_rectangle') {
      ws.send(JSON.stringify({
        type: 'create_rectangle', requestId: msg.requestId, ok: true,
        result: { id: '10:2', name: msg.payload.name, type: 'RECTANGLE', width: msg.payload.width, height: msg.payload.height },
      }));
    } else if (msg.type === 'create_component_from_node') {
      ws.send(JSON.stringify({
        type: 'create_component_from_node', requestId: msg.requestId, ok: true,
        result: { id: '20:1', name: msg.payload.name ?? 'Review Card', type: 'COMPONENT', width: 320, height: 200 },
      }));
    } else if (msg.type === 'create_component_set') {
      ws.send(JSON.stringify({
        type: 'create_component_set', requestId: msg.requestId, ok: true,
        result: { id: '20:9', name: msg.payload.name, type: 'COMPONENT_SET', width: 640, height: 200 },
      }));
    } else if (msg.type === 'get_variable') {
      ws.send(JSON.stringify({
        type: 'get_variable', requestId: msg.requestId, ok: false,
        error: { code: 'NOT_FOUND', message: 'Variable not found' },
      }));
    } else {
      ws.send(JSON.stringify({
        type: msg.type, requestId: msg.requestId, ok: false,
        error: { code: 'UNKNOWN_REQUEST', message: `No handler for "${msg.type}"` },
      }));
    }
  };
  ws.onerror = reject;
});
await wait(200);
check('плагин attached', lastState?.plugin?.connected === true);

// 3. MCP-адаптер
const adapter = spawn(process.execPath, [adapterPath, '--port', '9410', '--client', 'cursor'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
const stdoutLines = [];
let outBuf = '';
adapter.stdout.setEncoding('utf8');
adapter.stdout.on('data', (chunk) => {
  outBuf += chunk;
  let i;
  while ((i = outBuf.indexOf('\n')) !== -1) {
    const line = outBuf.slice(0, i).trim();
    outBuf = outBuf.slice(i + 1);
    if (line) stdoutLines.push(JSON.parse(line));
  }
});
adapter.stderr.on('data', () => {});

let nextId = 0;
const rpc = (method, params) => {
  const id = ++nextId;
  adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return id;
};
const waitReply = async (id, timeoutMs = 10_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = stdoutLines.find((m) => m.id === id);
    if (found) return found;
    await wait(50);
  }
  return null;
};
const bodyOf = (reply) => JSON.parse(reply.result.content.find((c) => c.type === 'text').text);

rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
const toolsListId = rpc('tools/list', {});
const statusId = rpc('tools/call', { name: 'get_status', arguments: {} });
const frameId = rpc('tools/call', { name: 'create_frame', arguments: { parentId: '0:1', name: 'Hero' } });
const layoutId = rpc('tools/call', { name: 'set_frame_layout', arguments: { id: '10:1', direction: 'HORIZONTAL', itemSpacing: 12 } });
const rectId = rpc('tools/call', { name: 'create_rectangle', arguments: { parentId: '10:1', name: 'Avatar', width: 48, height: 48 } });
const compId = rpc('tools/call', { name: 'create_component_from_node', arguments: { id: '10:1', name: 'Review Card / Default' } });
const compSetId = rpc('tools/call', { name: 'create_component_set', arguments: { parentId: '0:1', name: 'Review Card', componentIds: ['20:1', '20:2'] } });
const notFoundId = rpc('tools/call', { name: 'get_variable', arguments: { id: 'VariableID:1:1' } });
const unknownId = rpc('tools/call', { name: 'no_such_tool', arguments: {} });
const labelId = rpc('tools/call', { name: 'set_session_label', arguments: { label: 'smoke-test' } });

// run_batch: два create_frame, второй использует id первого как parentId
const tmp = mkdtempSync(path.join(tmpdir(), 'efb-batch-'));
const batchFile = path.join(tmp, 'batch.json');
writeFileSync(batchFile, JSON.stringify({
  ops: [
    { tool: 'create_frame', args: { parentId: '0:1', name: 'A' }, saves: { '$parent': 'id' } },
    { tool: 'create_frame', args: { parentId: '$parent', name: 'B' } },
  ],
}));
const batchId = rpc('tools/call', { name: 'run_batch', arguments: { file: batchFile } });

check('MCP initialize', (await waitReply(1))?.result?.serverInfo?.name === 'efigmabridge-desktop');

const toolsReply = await waitReply(toolsListId);
check(`tools/list → ${toolsCount} tools`, toolsReply?.result?.tools?.length === toolsCount, toolsReply?.result?.tools?.length);

const NEW_TOOLS = [
  'set_frame_layout', 'set_node_fills', 'set_node_strokes', 'set_node_corner_radius',
  'set_node_size', 'set_node_layout_child', 'create_rectangle', 'create_ellipse',
  'apply_style', 'bind_node_variable',
  'create_component_from_node', 'create_component', 'create_component_set', 'set_component_properties',
];
const listedNames = new Set((toolsReply?.result?.tools ?? []).map((t) => t.name));
check(
  'tools/list содержит 10 layout-tools',
  NEW_TOOLS.every((n) => listedNames.has(n)),
  NEW_TOOLS.filter((n) => !listedNames.has(n)).join(', ') || 'все на месте',
);

const statusReply = await waitReply(statusId);
const statusBody = statusReply && bodyOf(statusReply);
check(
  'get_status → server + plugin + file',
  statusBody?.plugin?.connected === true && statusBody?.file?.name === 'SmokeTest.fig' && statusBody?.server?.port === 9410,
  JSON.stringify(statusBody),
);

const frameReply = await waitReply(frameId);
check(
  'create_frame → результат плагина дошёл до LLM',
  bodyOf(frameReply)?.id === '10:1' && bodyOf(frameReply)?.name === 'Hero',
  JSON.stringify(bodyOf(frameReply)),
);

const layoutReply = await waitReply(layoutId);
check(
  'set_frame_layout → pass-through до плагина',
  bodyOf(layoutReply)?.id === '10:1' && bodyOf(layoutReply)?.type === 'FRAME',
  JSON.stringify(bodyOf(layoutReply)),
);

const rectReply = await waitReply(rectId);
check(
  'create_rectangle → pass-through до плагина',
  bodyOf(rectReply)?.id === '10:2' && bodyOf(rectReply)?.width === 48,
  JSON.stringify(bodyOf(rectReply)),
);

const compReply = await waitReply(compId);
check(
  'create_component_from_node → pass-through до плагина',
  bodyOf(compReply)?.type === 'COMPONENT' && bodyOf(compReply)?.name === 'Review Card / Default',
  JSON.stringify(bodyOf(compReply)),
);

const compSetReply = await waitReply(compSetId);
check(
  'create_component_set → pass-through до плагина',
  bodyOf(compSetReply)?.type === 'COMPONENT_SET' && bodyOf(compSetReply)?.id === '20:9',
  JSON.stringify(bodyOf(compSetReply)),
);

const notFoundReply = await waitReply(notFoundId);
check(
  'ошибка плагина → isError + {code, message}',
  notFoundReply?.result?.isError === true && bodyOf(notFoundReply)?.code === 'NOT_FOUND',
  JSON.stringify(bodyOf(notFoundReply)),
);

const unknownReply = await waitReply(unknownId);
check(
  'неизвестный tool → isError UNKNOWN_REQUEST',
  unknownReply?.result?.isError === true && bodyOf(unknownReply)?.code === 'UNKNOWN_REQUEST',
);

await waitReply(labelId);
await wait(300);
check('set_session_label → метка сменилась в мосте', lastState?.label === 'smoke-test', lastState?.label);

const batchReply = await waitReply(batchId);
check(
  'run_batch → 2 шага с placeholder-подстановкой',
  bodyOf(batchReply)?.done === 2 && bodyOf(batchReply)?.total === 2,
  JSON.stringify(bodyOf(batchReply)),
);

// 4. Плагин отвалился посреди запроса → TIMEOUT/PLUGIN_NOT_CONNECTED, а не зависание
plugin.close();
await wait(300);
const danglingId = rpc('tools/call', { name: 'create_frame', arguments: { parentId: '0:1', name: 'X' } });
const danglingReply = await waitReply(danglingId);
check(
  'запрос без плагина → isError PLUGIN_NOT_CONNECTED',
  danglingReply?.result?.isError === true && bodyOf(danglingReply)?.code === 'PLUGIN_NOT_CONNECTED',
  JSON.stringify(bodyOf(danglingReply)),
);

check('после закрытия плагина Figma помечается отключённой', lastState?.plugin?.connected === false);

adapter.kill();
await wait(400);
check('после выхода адаптера LLM исчезает из таблицы', lastState?.clients?.length === 0);

hub.stop();
await wait(200);
check('остановка моста освобождает порт', lastState?.port === null);

console.log(failures === 0 ? '\nВсе проверки пройдены.' : `\nПровалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
