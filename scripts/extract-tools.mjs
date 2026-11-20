// Извлекает определения tools из оригинального mcp-server (FrontMultitool bridge)
// в adapter/tools.json: name, title, description, annotations, inputSchema (JSON Schema),
// kind (как адаптер должен выполнять вызов), encoding, timeoutMs.
//
// Запуск: ./tools/node/node.exe scripts/extract-tools.mjs
// Скрипт использует node_modules оригинального проекта (zod, zod-to-json-schema),
// сами tools импортируются из его packages/mcp-server/dist.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC_ROOT = 'C:/Users/User24/Desktop/FrontMultitool/bridge/packages/mcp-server';
const DIST_TOOLS = `${SRC_ROOT}/dist/tools`;
const SRC_TOOLS = `${SRC_ROOT}/src/tools`;

const require = createRequire(pathToFileURL(path.join(SRC_ROOT, 'dist', 'index.js')).href);
const { z } = require('zod');
const { zodToJsonSchema } = require(
  'C:/Users/User24/Desktop/FrontMultitool/bridge/node_modules/.pnpm/zod-to-json-schema@3.25.2_zod@3.25.76/node_modules/zod-to-json-schema/dist/cjs/index.js',
);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outPath = path.join(root, 'adapter', 'tools.json');

// Мок McpServer: регистрация только записывает конфиг
const captured = [];
const server = {
  registerTool(name, config) {
    captured.push({ name, ...config });
    return { name, inputSchema: config.inputSchema };
  },
};
const bridge = {}; // обработчики не вызываем — нужны только метаданные

const SPECIAL_KINDS = { get_status: 'status', set_session_label: 'label', run_batch: 'batch' };

function classify(toolName, source) {
  if (SPECIAL_KINDS[toolName]) return { kind: SPECIAL_KINDS[toolName] };
  if (source.includes('callPluginToDataFile')) {
    const encoding = /callPluginToDataFile\(bridge, '\w+', [^;]*?'(base64|utf8)'/.exec(source)?.[1] ?? 'utf8';
    return { kind: 'dataFile', encoding, ...timeoutOf(source) };
  }
  if (source.includes('callPluginToFile')) return { kind: 'toFile', ...timeoutOf(source) };
  if (source.includes('bytesBase64')) return { kind: 'uploadBinary', ...timeoutOf(source) };
  if (source.includes('readFileSync') && /, svg \}\)/.test(source)) return { kind: 'uploadText', ...timeoutOf(source) };
  return { kind: 'plain', ...timeoutOf(source) };
}

// Последний числовой литерал в вызове callPlugin*(...) — таймаут; по умолчанию 30 с (как в WsBridge)
function timeoutOf(source) {
  const m = /callPlugin\w*\(bridge, '\w+',[^;]*?,\s*(\d[\d_]*)\s*\)/s.exec(source);
  return m ? { timeoutMs: Number(m[1].replaceAll('_', '')) } : {};
}

const files = readdirSync(DIST_TOOLS).filter((f) => {
  if (!f.endsWith('.js') || f === 'schemas.js') return false;
  // Файлы без исходника — устаревшие артефакты сборки: в index.ts они не регистрируются
  try {
    readFileSync(path.join(SRC_TOOLS, f.replace('.js', '.ts')));
    return true;
  } catch {
    console.log(`пропуск ${f}: нет исходника`);
    return false;
  }
});
for (const file of files) {
  const before = captured.length;
  const mod = await import(pathToFileURL(path.join(DIST_TOOLS, file)).href);
  // Исходник нужен только для классификации; если его нет (устаревший артефакт сборки) — читаем dist
  const srcPath = path.join(SRC_TOOLS, file.replace('.js', '.ts'));
  let source;
  try {
    source = readFileSync(srcPath, 'utf8');
  } catch {
    source = readFileSync(path.join(DIST_TOOLS, file), 'utf8');
  }
  for (const fn of Object.values(mod)) {
    if (typeof fn === 'function' && fn.name.startsWith('register') && fn.name !== 'registerRunBatch') {
      fn(server, bridge);
    }
  }
  for (const tool of captured.slice(before)) {
    Object.assign(tool, classify(tool.name, source));
  }
}

// run_batch регистрируется отдельно (registerRunBatch(server, tools))
const { registerRunBatch } = await import(pathToFileURL(path.join(DIST_TOOLS, 'runBatch.js')).href);
registerRunBatch(server, new Map());
Object.assign(captured[captured.length - 1], classify('run_batch', ''));

const tools = captured.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  annotations: tool.annotations,
  inputSchema: tool.inputSchema
    ? zodToJsonSchema(z.object(tool.inputSchema), { target: 'jsonSchema7' })
    : { type: 'object', properties: {} },
  kind: tool.kind,
  ...(tool.encoding ? { encoding: tool.encoding } : {}),
  ...(tool.timeoutMs ? { timeoutMs: tool.timeoutMs } : {}),
}));

// У zod-to-json-schema лишний $schema-ключ на верхнем уровне — убираем
for (const t of tools) delete t.inputSchema.$schema;

writeFileSync(outPath, JSON.stringify(tools, null, 2));
console.log(`Записано ${tools.length} tools в ${outPath}`);
console.log(tools.map((t) => `${t.name} [${t.kind}]`).join('\n'));
