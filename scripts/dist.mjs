// Сборка дистрибутива через программный API electron-builder.
// CLI electron-builder в этом окружении ломается (node — это Kimi.exe в режиме ELECTRON_RUN_AS_NODE,
// yargs получает искажённый argv), поэтому обходим yargs и вызываем API напрямую.
//
// Платформа: DIST_TARGET=win|mac или по умолчанию текущая ОС.
// macOS-пакет (zip/dmg, arm64) собирается только на macOS-хосте — подпись Apple.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const builder = require('electron-builder');
const fs = require('node:fs');
const path = require('node:path');

const target = process.env.DIST_TARGET || (process.platform === 'darwin' ? 'mac' : 'win');

// Kimi Work следит за workspace и держит дескрипторы на app.asar прошлой сборки,
// поэтому повторная сборка в ту же папку может упасть с EBUSY. Если папку нельзя
// удалить — собираем в новую с суффиксом.
let output = process.env.DIST_OUTPUT || 'release';
try {
  fs.rmSync(output, { recursive: true, force: true });
} catch { /* ignore */ }
if (fs.existsSync(output)) {
  output = `${output}-${Date.now()}`;
  console.log(`Папка по умолчанию заблокирована, собираю в ${output}`);
}

const targets =
  target === 'mac'
    ? builder.Platform.MAC.createTarget(['zip', 'dmg'], builder.Arch.arm64)
    : builder.Platform.WINDOWS.createTarget(['portable'], builder.Arch.x64);

const result = await builder.build({
  targets,
  config: { directories: { output: path.resolve(output) } },
  // В CI артефакты забирает upload-artifact; без publish: 'never' electron-builder
  // пытается публиковать релиз на GitHub и падает без GH_TOKEN
  publish: 'never',
});

console.log('Собранные артефакты:');
for (const file of result) console.log(' -', file);
