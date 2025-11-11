// @ts-check
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

/**
 * Статус-барный элемент со временем секундомера.
 * @type {vscode.StatusBarItem | undefined}
 */
let statusItem;

/**
 * @type {ReturnType<typeof setInterval> | undefined}
 */
let tick;

/**
 * Флаги и счётчики для секундомера
 */
let running = false;
let paused = false;
let startMs = 0;
let pausedAccum = 0;
let pauseStartMs = 0;

/**
 * Для отметки изменённых файлы для бэкапа.
 * @type {vscode.FileSystemWatcher | undefined}
 */
let backupWatcher;

/**
 * Относительные пути изменённых файлов для бэкапов.
 * @type {Set<string>}
 */
let backupTouched = new Set();

/**
 * Таймер для бэкапов.
 * @type {ReturnType<typeof setInterval> | undefined}
 */
let backupTimer;

/**
 * @type {vscode.Disposable[]}
 */
let disposables = [];

/**
 * Установка времени для бэкапов: YYYYMMDD-HHMMSS.
 */
function localStamp() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}-${HH}${mm}${ss}`;
}

/**
 * Локальное время
 */
function localISOWithTZ() {
  const d = new Date();
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  const tzh = String(Math.floor(abs / 60)).padStart(2, '0');
  const tzm = String(abs % 60).padStart(2, '0');

  const yyyy = String(d.getFullYear());
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}${sign}${tzh}:${tzm}`;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('work-mode.start', startWorkMode),
    vscode.commands.registerCommand('work-mode.stop', stopWorkMode),
    vscode.commands.registerCommand('work-mode.toggle', toggleWorkMode),
    vscode.commands.registerCommand('work-mode.pauseResume', pauseResume),
    vscode.commands.registerCommand('work-mode.showLog', showLog),
    vscode.commands.registerCommand('work-mode.openBackupsFolder', openBackupsFolder)
  );
}

/**
 * Остановка работы расширения
 */
function deactivate() { stopWorkMode(); }

/**
 * Переключатель остановка/запуск
 */
async function toggleWorkMode() { running ? await stopWorkMode() : await startWorkMode(); }

/**
 * Старт
 */
async function startWorkMode() {
  if (running) return;
  const cfg = vscode.workspace.getConfiguration('work-mode');
  if (cfg.get('enableMinimalUI')) await enableMinimalUI();
  initStopwatch();
  await startIncrementalBackups();
  await appendSessionLog({ event: 'start', at: localISOWithTZ() });
  vscode.window.setStatusBarMessage('Work Mode: started', 2000);
}

/**
 * Остановка
 */
async function stopWorkMode() {
  if (!running) return;

  if (tick) { clearInterval(tick); tick = undefined; }
  running = false;
  paused = false;

  if (statusItem) { statusItem.dispose(); statusItem = undefined; }

  await stopIncrementalBackups(true);
  await disableMinimalUI();
  await appendSessionLog({ event: 'stop', at: localISOWithTZ(), durationMs: elapsedMs() });

  const elapsed = formatElapsed(elapsedMs());
  vscode.window.setStatusBarMessage(`Work Mode: stopped · ${elapsed}`, 4000);
}

/**
 * Пауза/продолжение секундомера
 */
async function pauseResume() {
  if (!running) return;
  if (!paused) {
    paused = true;
    pauseStartMs = Date.now();
    if (statusItem) {
      statusItem.text = statusItem.text.replace('▶', '⏸');
      statusItem.tooltip = 'Пауза — кликни, чтобы продолжить';
    }
  } else {
    paused = false;
    pausedAccum += Date.now() - pauseStartMs;
    pauseStartMs = 0;
    if (statusItem) {
      statusItem.text = statusItem.text.replace('⏸', '▶');
      statusItem.tooltip = 'Идёт сессия — кликни, чтобы поставить на паузу';
    }
  }
}

/**
 * Показываем статус-бар, прячем activity bar
 * и закрываем боковую/нижнюю панели.
 */
async function enableMinimalUI() {
  const wb = vscode.workspace.getConfiguration('workbench');
  await wb.update('statusBar.visible', true, vscode.ConfigurationTarget.Global);
  await wb.update('activityBar.location', 'hidden', vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
}

/**
 * Возвращаем activity bar слева,
 * открываем Explorer и нижнюю панель.
 */
async function disableMinimalUI() {
  const wb = vscode.workspace.getConfiguration('workbench');
  await wb.update('activityBar.location', 'left', vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.commands.executeCommand('workbench.action.togglePanel');
}

/**
 * Создаём секундомер в статус-баре и
 * раз в секунду обновляем прошедшее время.
 */
function initStopwatch() {
  running = true;
  paused = false;
  startMs = Date.now();
  pausedAccum = 0;
  pauseStartMs = 0;

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.name = 'Work Mode — Stopwatch';
  statusItem.command = 'work-mode.pauseResume';
  statusItem.tooltip = 'Идёт сессия — кликни, чтобы поставить на паузу';
  statusItem.text = '$(watch) ▶ 00:00:00';
  statusItem.show();

  tick = setInterval(() => {
    if (!running || paused) return;
    if (statusItem) statusItem.text = `$(watch) ▶ ${formatElapsed(elapsedMs())}`;
  }, 1000);
}

/**
 * Возвращает прошедшее время в миллисекундах с учётом паузы.
 * На паузе хвостовое время вычитается.
 * @returns {number}
 */
function elapsedMs() {
  const now = Date.now();
  const pauseTail = paused && pauseStartMs ? (now - pauseStartMs) : 0;
  return Math.max(0, now - startMs - pausedAccum - pauseTail);
}

/**
 * Форматирует миллисекунды в строку HH:MM:SS.
 * @param {number} ms
 * @returns {string}
 */
function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Запуск бэкапов:
 * — помечание изменившихся файлов
 * — таймер раз в n секунд пытается собрать zip при наличии изменений.
 */
async function startIncrementalBackups() {
  const cfg = vscode.workspace.getConfiguration('work-mode');
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;

  const pattern = new vscode.RelativePattern(ws, '**/*');
  backupWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);

  /** @param {vscode.Uri} uri — абсолютный URI изменённого файла */
  const markChanged = (uri) => {
    if (!uri || uri.scheme !== 'file') return;
    const rel = path.relative(ws.uri.fsPath, uri.fsPath);
    if (rel.startsWith('..') || shouldExclude(rel)) return;
    backupTouched.add(rel.replace(/\\/g, '/'));
  };
  backupWatcher.onDidChange(markChanged);
  backupWatcher.onDidCreate(markChanged);

  disposables.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      const doc = e.document;
      if (doc.uri.scheme === 'file') {
        const rel = path.relative(ws.uri.fsPath, doc.uri.fsPath);
        if (!rel.startsWith('..') && !shouldExclude(rel)) {
          backupTouched.add(rel.replace(/\\/g, '/'));
        }
      }
    }),
    vscode.workspace.onDidOpenTextDocument(() => {})
  );

  const intervalSec = Math.max(10, cfg.get('backup.intervalSec') ?? 60);
  backupTimer = setInterval(async () => {
    await createIncrementalZipIfNeeded();
  }, intervalSec * 1000);
}

/**
 * Остановка инкрементных бэкапов:
 * — убираем таймер
 * — при флаге делаем финальный zip
 */
async function stopIncrementalBackups(makeFinalZip = false) {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = undefined; }
  if (backupWatcher) { backupWatcher.dispose(); backupWatcher = undefined; }
  disposables.forEach(d => { try { d.dispose(); } catch {} });
  disposables = [];
  if (makeFinalZip) await createIncrementalZipIfNeeded();
  backupTouched.clear();
}

/** 
 * Исключений для бэкапов: node_modules/.git/dist и т.п.,
 * @param {string} relPath
 * @returns {boolean}
 */
function shouldExclude(relPath) {
  const cfg = vscode.workspace.getConfiguration('work-mode');
  /** @type {string[]} */
  const patterns = cfg.get('backup.excludes') || [];
  const p = relPath.replace(/\\/g, '/');
  const quick = ['node_modules/', '.git/', 'dist/', '.vscode-work-mode/'];
  if (quick.some(q => p.includes(q))) return true;

  return patterns.some(
    /** @param {string} glob */
    (glob) => {
      if (glob.endsWith('/**')) return p.includes(glob.slice(0, -3).replace(/^(\*\*\/)?/, ''));
      if (glob.startsWith('**/')) return p.includes(glob.slice(3));
      if (glob.startsWith('*.')) return p.endsWith(glob.slice(1));
      return false;
    }
  );
}

/**
 * Попытка собрать zip:
 * — берём помеченные пути
 * — если нужно — сохраняем zip, ограничиваем их количество, дополняем логи.
 */
async function createIncrementalZipIfNeeded() {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;

  const fromDisk = Array.from(backupTouched);

  /** @type {{zipPath: string, content: Uint8Array}[]} — несохранённые и untitled документы */
  const unsavedEntries = [];
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty && doc.uri.scheme !== 'untitled') continue;

    if (doc.uri.scheme === 'file') {
      const rel = path.relative(ws.uri.fsPath, doc.uri.fsPath).replace(/\\/g, '/');
      if (rel.startsWith('..') || shouldExclude(rel)) continue;
      const text = doc.getText();
      unsavedEntries.push({ zipPath: rel, content: new TextEncoder().encode(text) });
    } else if (doc.uri.scheme === 'untitled') {
      const name = (doc.fileName || 'untitled.txt').split(/[\\/]/).pop() || 'untitled.txt';
      const rel = `UNSAVED/${name}`;
      const text = doc.getText();
      unsavedEntries.push({ zipPath: rel, content: new TextEncoder().encode(text) });
    }
  }

  // Нечего сохранять
  if (fromDisk.length === 0 && unsavedEntries.length === 0) return;

  const cfg = vscode.workspace.getConfiguration('work-mode');
  const backupsDir = vscode.Uri.joinPath(ws.uri, '.vscode-work-mode', 'backups');
  await vscode.workspace.fs.createDirectory(backupsDir);

  const zipName = `${localStamp()}-changed.zip`;
  const zipPath = vscode.Uri.joinPath(backupsDir, zipName);

  const zip = new AdmZip();

  for (const entry of unsavedEntries) {
    try { zip.addFile(entry.zipPath, Buffer.from(entry.content)); } catch {}
  }

  for (const rel of fromDisk) {
    try {
      const abs = path.join(ws.uri.fsPath, rel);
      const stat = await fs.promises.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      if (shouldExclude(rel)) continue;
      const data = await fs.promises.readFile(abs);
      zip.addFile(rel.replace(/\\/g, '/'), Buffer.from(data));
    } catch {}
  }


  if (zip.getEntries().length === 0) return;


  await fs.promises.writeFile(zipPath.fsPath, zip.toBuffer());
  await enforceBackupLimit(backupsDir, cfg.get('backup.maxItems') ?? 300);
  await appendBackupLog(ws.uri, zipName, zip.getEntries().length);

  vscode.window.setStatusBarMessage(`Backup saved (${zip.getEntries().length} files)`, 3000);
  backupTouched.clear();
}

/**
 * Ограничение числа ZIP-файлов в каталоге бэкапов
 * @param {vscode.Uri} dirUri
 * @param {number} maxItems
 */
async function enforceBackupLimit(dirUri, maxItems) {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    const zips = entries
      .filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.zip'))
      .map(([n]) => n)
      .sort();
    while (zips.length > maxItems) {
      const oldest = zips.shift();
      if (oldest) await vscode.workspace.fs.delete(vscode.Uri.joinPath(dirUri, oldest));
    }
  } catch {}
}

/**
 * @param {vscode.Uri} fileUri
 * @param {any} obj
 */
async function appendJsonlLine(fileUri, obj) {
  const enc = new TextEncoder();
  const line = enc.encode(JSON.stringify(obj) + '\n');
  let prev = new Uint8Array();
  try {
    const data = await vscode.workspace.fs.readFile(fileUri);
    prev = new Uint8Array(data);
  } catch {}
  const out = new Uint8Array(prev.length + line.length);
  out.set(prev, 0);
  out.set(line, prev.length);
  await vscode.workspace.fs.writeFile(fileUri, out);
}

/**
 * Запись события бэкапа в журнал backups.jsonl.
 * @param {vscode.Uri} wsUri
 * @param {string} zipName
 * @param {number} filesCount
 */
async function appendBackupLog(wsUri, zipName, filesCount) {
  try {
    const logsDir = vscode.Uri.joinPath(wsUri, '.vscode-work-mode', 'logs');
    await vscode.workspace.fs.createDirectory(logsDir);
    const file = vscode.Uri.joinPath(logsDir, 'backups.jsonl');
    await appendJsonlLine(file, { at: localISOWithTZ(), zip: zipName, files: filesCount });
  } catch {}
}

/**
 * Запись событий сессии (start/stop и длительность) в sessions.jsonl.
 * @param {{event?: string, at?: string, durationMs?: number}} obj
 */
async function appendSessionLog(obj) {
  try {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!ws) return;
    const logsDir = vscode.Uri.joinPath(ws, '.vscode-work-mode', 'logs');
    await vscode.workspace.fs.createDirectory(logsDir);
    const file = vscode.Uri.joinPath(logsDir, 'sessions.jsonl');
    await appendJsonlLine(file, obj);
  } catch {}
}

/**
 * Команда «показать логи»: открывает оба файла журналов в редакторе,
 * если открыт workspace. Иначе показывает уведомление.
 */
async function showLog() {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) { vscode.window.showInformationMessage('Откройте папку проекта, чтобы посмотреть журнал'); return; }
  const sessions = vscode.Uri.joinPath(ws, '.vscode-work-mode', 'logs', 'sessions.jsonl');
  const backups = vscode.Uri.joinPath(ws, '.vscode-work-mode', 'logs', 'backups.jsonl');
  await vscode.commands.executeCommand('vscode.open', sessions);
  try { await vscode.commands.executeCommand('vscode.open', backups); } catch {}
}

/**
 * Команда «открыть папку бэкапов» — показывает каталог в проводнике ОС.
 */
async function openBackupsFolder() {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) return;
  const dir = vscode.Uri.joinPath(ws, '.vscode-work-mode', 'backups');
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.commands.executeCommand('revealFileInOS', dir);
}

/** Экспорт точек входа расширения. */
module.exports = { activate, deactivate };
