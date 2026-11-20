<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';

const state = ref(null);
const busy = ref(false);
const copied = ref(''); // 'config' | 'manifest' — что только что скопировано
let unsubscribe = null;

// Список LLM и генераторы их MCP-конфига (build получает путь к адаптеру и порт моста)
const stdioServer = (adapterPath, port, client) => ({
  command: 'node',
  args: [adapterPath, '--port', String(port), '--client', client],
});
const LLMS = [
  {
    id: 'claude-desktop', name: 'Claude Desktop', client: 'claude-desktop',
    hint: 'claude_desktop_config.json',
    build: (p, port) => ({ mcpServers: { efigmabridge: stdioServer(p, port, 'claude-desktop') } }),
  },
  {
    id: 'cursor', name: 'Cursor', client: 'cursor',
    hint: 'mcp.json (настройки Cursor)',
    build: (p, port) => ({ mcpServers: { efigmabridge: stdioServer(p, port, 'cursor') } }),
  },
  {
    id: 'windsurf', name: 'Windsurf', client: 'windsurf',
    hint: 'mcp_config.json',
    build: (p, port) => ({ mcpServers: { efigmabridge: stdioServer(p, port, 'windsurf') } }),
  },
  {
    id: 'vscode', name: 'VS Code', client: 'vscode',
    hint: '.vscode/mcp.json',
    build: (p, port) => ({ servers: { efigmabridge: stdioServer(p, port, 'vscode') } }),
  },
  {
    id: 'opencode', name: 'OpenCode', client: 'opencode',
    hint: 'opencode.json (проект) или ~/.config/opencode/opencode.json',
    build: (p, port) => ({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        efigmabridge: {
          type: 'local',
          command: ['node', p, '--port', String(port), '--client', 'opencode'],
          enabled: true,
        },
      },
    }),
  },
  {
    id: 'kimi', name: 'Kimi Code CLI', client: 'kimi',
    hint: '~/.kimi-code/mcp.json или .kimi-code/mcp.json',
    build: (p, port) => ({ mcpServers: { efigmabridge: stdioServer(p, port, 'kimi') } }),
  },
];
const selectedLlmId = ref(LLMS[0].id);

const running = computed(() => !!state.value?.running);

const selectedLlm = computed(() => LLMS.find((l) => l.id === selectedLlmId.value));

// JSON для вставки в файл настроек MCP выбранной LLM
const configJson = computed(() => {
  if (!state.value?.running) return '';
  return JSON.stringify(selectedLlm.value.build(state.value.paths.adapter, state.value.port), null, 2);
});

// Строки таблицы состояний: LLM-сессии + Figma
const rows = computed(() => {
  if (!state.value) return [];
  const result = state.value.clients.map((c) => ({
    id: c.id,
    type: 'LLM',
    name: c.client,
    session: state.value.label,
    port: state.value.port,
    status: 'Подключена',
    tone: 'ok',
    time: c.connectedAt,
  }));
  result.push({
    id: 'figma',
    type: 'Figma',
    name: state.value.plugin.connected ? `Файл «${state.value.plugin.fileName}»` : '—',
    session: state.value.label,
    port: state.value.port,
    status: state.value.plugin.connected ? 'Подключена' : 'Ожидание плагина…',
    tone: state.value.plugin.connected ? 'ok' : 'wait',
    time: state.value.plugin.connected ? null : null,
  });
  return result;
});

async function start() {
  busy.value = true;
  try {
    state.value = await window.efigma.start();
  } finally {
    busy.value = false;
  }
}

async function stop() {
  busy.value = true;
  try {
    state.value = await window.efigma.stop();
  } finally {
    busy.value = false;
  }
}

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = what;
    setTimeout(() => { if (copied.value === what) copied.value = ''; }, 2000);
  } catch { /* буфер недоступен — пользователь скопирует вручную */ }
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

onMounted(async () => {
  state.value = await window.efigma.getState();
  unsubscribe = window.efigma.onState((next) => { state.value = next; });
});

onUnmounted(() => { if (unsubscribe) unsubscribe(); });
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Шапка -->
    <header class="flex items-center justify-between px-6 py-4 border-b border-slate-800">
      <div class="flex items-center gap-3">
        <div class="w-8 h-8 rounded-lg bg-indigo-500 flex items-center justify-center font-bold text-white">eF</div>
        <h1 class="text-lg font-semibold">eFigmaBridge</h1>
      </div>
      <div class="flex items-center gap-2 text-sm">
        <span
          class="inline-block w-2.5 h-2.5 rounded-full"
          :class="running ? 'bg-emerald-400' : 'bg-slate-500'"
        ></span>
        <span class="text-slate-300">
          {{ running ? `Мост запущен — порт ${state.port}` : 'Мост остановлен' }}
        </span>
      </div>
    </header>

    <main class="flex-1 px-6 py-8 max-w-4xl w-full mx-auto">
      <!-- Ошибка запуска -->
      <div
        v-if="state?.error"
        class="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
      >
        {{ state.error }}
      </div>

      <!-- Нет подключений: кнопка запуска -->
      <div v-if="!running" class="flex flex-col items-center justify-center py-24 text-center">
        <p class="text-slate-400 mb-8 max-w-md">
          Мост между LLM и Figma не запущен. Нажмите кнопку, чтобы поднять
          WebSocket-сервер и получить данные для подключения.
        </p>
        <button
          class="px-8 py-3 rounded-xl bg-indigo-500 hover:bg-indigo-400 active:bg-indigo-600
                 text-white font-semibold text-lg transition disabled:opacity-50"
          :disabled="busy"
          @click="start"
        >
          {{ busy ? 'Запуск…' : 'Запустить мост' }}
        </button>
      </div>

      <!-- Мост запущен -->
      <div v-else class="space-y-6">
        <!-- Подключение LLM -->
        <section class="rounded-xl border border-slate-800 bg-slate-800/40 p-5">
          <h2 class="font-semibold mb-1">1. Подключите LLM</h2>
          <p class="text-sm text-slate-400 mb-4">
            Выберите LLM и вставьте JSON в её файл настроек MCP
            <span class="text-slate-500">({{ selectedLlm.hint }})</span>, затем перезапустите LLM.
          </p>
          <div class="flex flex-wrap items-center gap-3 mb-3">
            <select
              v-model="selectedLlmId"
              class="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm
                     focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option v-for="llm in LLMS" :key="llm.id" :value="llm.id">{{ llm.name }}</option>
            </select>
            <button
              class="ml-auto px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm transition"
              @click="copy(configJson, 'config')"
            >
              {{ copied === 'config' ? 'Скопировано ✓' : 'Копировать JSON' }}
            </button>
          </div>
          <textarea
            readonly
            :value="configJson"
            rows="9"
            class="w-full font-mono text-xs bg-slate-950 border border-slate-800 rounded-lg p-3
                   text-emerald-300 focus:outline-none resize-y"
            @focus="$event.target.select()"
          ></textarea>
        </section>

        <!-- Подключение Figma -->
        <section class="rounded-xl border border-slate-800 bg-slate-800/40 p-5">
          <h2 class="font-semibold mb-1">2. Подключите Figma</h2>
          <p class="text-sm text-slate-400 mb-4">
            В Figma Desktop: <span class="text-slate-300">Plugins → Development → Import plugin from manifest…</span>
            и укажите этот файл. Затем запустите плагин в открытом файле.
          </p>
          <div class="flex items-center gap-3">
            <input
              readonly
              :value="state.paths.manifest"
              class="flex-1 font-mono text-xs bg-slate-950 border border-slate-800 rounded-lg px-3 py-2
                     text-sky-300 focus:outline-none"
              @focus="$event.target.select()"
            />
            <button
              class="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm transition whitespace-nowrap"
              @click="copy(state.paths.manifest, 'manifest')"
            >
              {{ copied === 'manifest' ? 'Скопировано ✓' : 'Копировать путь' }}
            </button>
          </div>
          <p v-if="!state.paths.manifestExists" class="mt-2 text-xs text-amber-400">
            Файл манифеста не найден по этому пути — проверьте сборку плагина.
          </p>
        </section>

        <!-- Таблица состояний -->
        <section class="rounded-xl border border-slate-800 bg-slate-800/40 p-5">
          <h2 class="font-semibold mb-4">Подключения</h2>
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-slate-400 border-b border-slate-700">
                <th class="pb-2 pr-4 font-medium">Тип</th>
                <th class="pb-2 pr-4 font-medium">Имя</th>
                <th class="pb-2 pr-4 font-medium">Сессия</th>
                <th class="pb-2 pr-4 font-medium">Порт</th>
                <th class="pb-2 pr-4 font-medium">Статус</th>
                <th class="pb-2 font-medium">Время</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in rows"
                :key="row.id"
                class="border-b border-slate-800 last:border-0"
              >
                <td class="py-2.5 pr-4">
                  <span
                    class="px-2 py-0.5 rounded text-xs font-medium"
                    :class="row.type === 'LLM' ? 'bg-indigo-500/20 text-indigo-300' : 'bg-pink-500/20 text-pink-300'"
                  >{{ row.type }}</span>
                </td>
                <td class="py-2.5 pr-4">{{ row.name }}</td>
                <td class="py-2.5 pr-4 text-slate-400">{{ row.session }}</td>
                <td class="py-2.5 pr-4 font-mono text-xs">{{ row.port ?? '—' }}</td>
                <td class="py-2.5 pr-4">
                  <span class="flex items-center gap-2">
                    <span
                      class="inline-block w-2 h-2 rounded-full"
                      :class="row.tone === 'ok' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'"
                    ></span>
                    <span :class="row.tone === 'ok' ? 'text-emerald-300' : 'text-amber-300'">{{ row.status }}</span>
                  </span>
                </td>
                <td class="py-2.5 text-slate-400 font-mono text-xs">{{ fmtTime(row.time) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div class="flex justify-end">
          <button
            class="px-4 py-2 rounded-lg border border-slate-700 hover:bg-slate-800 text-sm text-slate-300 transition disabled:opacity-50"
            :disabled="busy"
            @click="stop"
          >
            Остановить мост
          </button>
        </div>
      </div>
    </main>
  </div>
</template>
