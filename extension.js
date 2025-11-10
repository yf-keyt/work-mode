// @ts-check
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

let statusItem;          // статус-бар секундомера
let tick;                // таймер секундомера
let running = false;
let paused = false;
let startMs = 0;
let pausedAccum = 0;
let pauseStartMs = 0;

// ---- инкрементные бэкапы (диск + несохранённые правки)
let backupWatcher;                 // FileSystemWatcher по ФС
let backupTouched = new Set();     // относительные пути, изменённые на диске/в редакторе
let backupTimer;                   // setInterval
let disposables = [];              // для подписок на события редактора

// ──────────────────────────────────────────────────────────────────────────────
// Локальные метки времени

function localStamp() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  // для имени файла: YYYYMMDD-HHMMSS
  return `${yyyy}${MM}${dd}-${HH}${mm}${ss}`;
}

function localISOWithTZ() {
  const d = new Date();
  const tz = -d.getTimezoneOffset(); // в минутах, положительное — восточнее UTC
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

  // пример: 2025-11-10T17:30:45+03:00
  return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}${sign}${tzh}:${tzm}`;
}

/** @param {vscode.ExtensionContext} context */
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

function deactivate() { stopWorkMode(); }

// ──────────────────────────────────────────────────────────────────────────────
// Режим работы

async function toggleWorkMode() { running ? await stopWorkMode() : await startWorkMode(); }

async function startWorkMode() {
  if (running) return;

  const cfg = vscode.workspace.getConfiguration('work-mode');
  if (cfg.get('enableMinimalUI')) await enableMinimalUI();

  initStopwatch();

  await startIncrementalBackups();              // бэкапы (включая dirty-документы)
  await appendSessionLog({ event: 'start', at: localISOWithTZ() });

  vscode.window.setStatusBarMessage('Work Mode: started', 2000);
}

async function stopWorkMode() {
  if (!running) return;

  clearInterval(tick);
  tick = undefined;
  running = false;
  paused = false;
  if (statusItem) { statusItem.dispose(); statusItem = undefined; }

  await stopIncrementalBackups(true);           // финальный бэкап, включая несохранённые

  await disableMinimalUI();

  await appendSessionLog({
    event: 'stop',
    at: localISOWithTZ(),
    durationMs: elapsedMs()
  });

  const elapsed = formatElapsed(elapsedMs());
  vscode.window.setStatusBarMessage(`Work Mode: stopped · ${elapsed}`, 4000);
}

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

// ──────────────────────────────────────────────────────────────────────────────
// Минималистичный UI (без Zen Mode)

async function enableMinimalUI() {
  const wb = vscode.workspace.getConfiguration('workbench');

  // статус-бар должен быть виден
  await wb.update('statusBar.visible', true, vscode.ConfigurationTarget.Global);

  // спрячем Activity Bar (современное свойство)
  await wb.update('activityBar.location', 'hidden', vscode.ConfigurationTarget.Global);

  // закроем нижнюю и боковую панели
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
}

async function disableMinimalUI() {
  const wb = vscode.workspace.getConfiguration('workbench');

  // вернём Activity Bar
  await wb.update('activityBar.location', 'left', vscode.ConfigurationTarget.Global);

  // откроем боковую панель (Explorer) и нижнюю панель
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.commands.executeCommand('workbench.action.togglePanel');
}

// ──────────────────────────────────────────────────────────────────────────────
/** Секундомер */

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

function elapsedMs() {
  const now = Date.now();
  const pauseTail = paused && pauseStartMs ? (now - pauseStartMs) : 0;
  return Math.max(0, now - startMs - pausedAccum - pauseTail);
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Инкрементные бэкапы (диск + несохранённые правки)

async function startIncrementalBackups() {
  const cfg = vscode.workspace.getConfiguration('work-mode');
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;

  // 1) FileSystemWatcher — изменения НА ДИСКЕ
  const pattern = new vscode.RelativePattern(ws, '**/*');
  backupWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
  const markChanged = (uri) => {
    if (!uri || uri.scheme !== 'file') return;
    const rel = path.relative(ws.uri.fsPath, uri.fsPath);
    if (rel.startsWith('..') || shouldExclude(rel)) return;
    backupTouched.add(rel.replace(/\\/g, '/'));
  };
  backupWatcher.onDidChange(markChanged);
  backupWatcher.onDidCreate(markChanged);

  // 2) Изменения в редакторе (dirty/untitled)
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

  // 3) Таймер по интервалу
  const intervalSec = Math.max(10, cfg.get('backup.intervalSec') ?? 60);
  backupTimer = setInterval(async () => {
    await createIncrementalZipIfNeeded();
  }, intervalSec * 1000);
}

async function stopIncrementalBackups(makeFinalZip = false) {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = undefined; }
  if (backupWatcher) { backupWatcher.dispose(); backupWatcher = undefined; }
  disposables.forEach(d => { try { d.dispose(); } catch {} });
  disposables = [];
  if (makeFinalZip) await createIncrementalZipIfNeeded();
  backupTouched.clear();
}

function shouldExclude(relPath) {
  const cfg = vscode.workspace.getConfiguration('work-mode');
  const patterns = cfg.get('backup.excludes') || [];
  const p = relPath.replace(/\\/g, '/');
  const quick = ['node_modules/', '.git/', 'dist/', '.vscode-work-mode/'];
  if (quick.some(q => p.includes(q))) return true;

  return patterns.some(glob => {
    if (glob.endsWith('/**')) return p.includes(glob.slice(0, -3).replace(/^(\*\*\/)?/, ''));
    if (glob.startsWith('**/')) return p.includes(glob.slice(3));
    if (glob.startsWith('*.')) return p.endsWith(glob.slice(1));
    return false;
  });
}

/**
 * Собираем ZIP, если есть что паковать — ИЗ:
 *  - файлов, изменённых на диске (backupTouched),
 *  - ЛЮБЫХ открытых dirty-документов (без ⌘S),
 *  - untitled-документов в папку UNSAVED/.
 */
async function createIncrementalZipIfNeeded() {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;

  // Список файлов с диска (по слежению)
  const fromDisk = Array.from(backupTouched);

  // Список текущих dirty/untitled документов
  /** @type {{zipPath: string, content: Uint8Array}[]} */
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

  if (fromDisk.length === 0 && unsavedEntries.length === 0) return;

  const cfg = vscode.workspace.getConfiguration('work-mode');
  const backupsDir = vscode.Uri.joinPath(ws.uri, '.vscode-work-mode', 'backups');
  await vscode.workspace.fs.createDirectory(backupsDir);

  const zipName = `${localStamp()}-changed.zip`;
  const zipPath = vscode.Uri.joinPath(backupsDir, zipName);

  const zip = new AdmZip();

  // 1) несохранённые правки
  for (const entry of unsavedEntries) {
    try { zip.addFile(entry.zipPath, Buffer.from(entry.content)); } catch {}
  }

  // 2) файлы с диска
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

  vscode.window.setStatusBarMessage(`💾 Backup saved (${zip.getEntries().length} files)`, 3000);
  backupTouched.clear();
}

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

// === универсальная запись в *.jsonl без Buffer ===============================
async function appendJsonlLine(fileUri, obj) {
  const enc = new TextEncoder();
  const line = enc.encode(JSON.stringify(obj) + '\n');

  /** @type {Uint8Array} */
  let prev = new Uint8Array();
  try {
    const data = await vscode.workspace.fs.readFile(fileUri);
    prev = new Uint8Array(data); // явное приведение
  } catch {}

  const out = new Uint8Array(prev.length + line.length);
  out.set(prev, 0);
  out.set(line, prev.length);
  await vscode.workspace.fs.writeFile(fileUri, out);
}

async function appendBackupLog(wsUri, zipName, filesCount) {
  try {
    const logsDir = vscode.Uri.joinPath(wsUri, '.vscode-work-mode', 'logs');
    await vscode.workspace.fs.createDirectory(logsDir);
    const file = vscode.Uri.joinPath(logsDir, 'backups.jsonl');
    await appendJsonlLine(file, { at: localISOWithTZ(), zip: zipName, files: filesCount });
  } catch {}
}

// ──────────────────────────────────────────────────────────────────────────────
// Журнал сессий и вспомогательные команды

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

async function showLog() {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) { vscode.window.showInformationMessage('Откройте папку проекта, чтобы посмотреть журнал'); return; }
  const sessions = vscode.Uri.joinPath(ws, '.vscode-work-mode', 'logs', 'sessions.jsonl');
  const backups = vscode.Uri.joinPath(ws, '.vscode-work-mode', 'logs', 'backups.jsonl');
  await vscode.commands.executeCommand('vscode.open', sessions);
  try { await vscode.commands.executeCommand('vscode.open', backups); } catch {}
}

async function openBackupsFolder() {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!ws) return;
  const dir = vscode.Uri.joinPath(ws, '.vscode-work-mode', 'backups');
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.commands.executeCommand('revealFileInOS', dir);
}

module.exports = { activate, deactivate };
