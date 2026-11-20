// Лаунчер Electron: снимает ELECTRON_RUN_AS_NODE, если она унаследована из окружения
// (на этой машине она выставлена на уровне пользователя и мешает запуску любого Electron-приложения).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron'); // путь к electron.exe

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
