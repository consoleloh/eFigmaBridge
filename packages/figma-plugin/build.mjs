import * as esbuild from 'esbuild';
import { writeFileSync, mkdirSync } from 'fs';

const watch = process.argv.includes('--watch');

// SPEC 5.2.2: session dropdown, under it the connection status and busy state
const html = (uiScript) =>
  `<!DOCTYPE html><html><head><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,-apple-system,sans-serif;font-size:12px;background:#2c2c2c;color:#e0e0e0;padding:12px 16px}select{width:100%;height:28px;padding:0 6px;margin-bottom:10px;background:#383838;color:#e0e0e0;border:1px solid #4a4a4a;border-radius:4px;font:inherit}option:disabled{color:#888}.status{display:flex;align-items:center;gap:8px}.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:#888}.dot.connecting{background:#888}.dot.connected{background:#2da44e}.dot.reconnecting{background:#d4a72c}.dot.closed{background:#cf4a4a}#status-text{font-size:12px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style></head><body><select id="session" title="Сессия Claude"></select><div class="status"><div class="dot connecting" id="dot"></div><span id="status-text">Поиск сессий…</span></div><script>${uiScript}</script></body></html>`;

// Ensure dist/ directory exists
mkdirSync('dist', { recursive: true });

if (watch) {
  // Watch mode — use esbuild context API

  // Context for main thread (code.js)
  const mainCtx = await esbuild.context({
    entryPoints: ['src/main.ts'],
    bundle: true,
    outfile: 'dist/code.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2017',
    treeShaking: true,
  });

  // Context for UI iframe (ui.html) — rebuilds and regenerates HTML on each change
  const uiCtx = await esbuild.context({
    entryPoints: ['src/ui.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2017',
    write: false,
    plugins: [
      {
        name: 'write-ui-html',
        setup(build) {
          build.onEnd((result) => {
            if (result.outputFiles && result.outputFiles.length > 0) {
              const uiScript = result.outputFiles[0].text;
              writeFileSync(
                'dist/ui.html',
                html(uiScript)
              );
            }
          });
        },
      },
    ],
  });

  await mainCtx.watch();
  await uiCtx.watch();

  console.log('[build] watching for changes...');
} else {
  // One-shot build mode

  // Build 1: main thread → dist/code.js
  await esbuild.build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    outfile: 'dist/code.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2017',
    treeShaking: true,
  });

  // Build 2: UI iframe → dist/ui.html (inline script)
  const uiResult = await esbuild.build({
    entryPoints: ['src/ui.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2017',
    write: false,
  });

  const uiScript = uiResult.outputFiles[0].text;
  writeFileSync(
    'dist/ui.html',
    html(uiScript)
  );

  console.log('[build] done — dist/code.js and dist/ui.html');
}
