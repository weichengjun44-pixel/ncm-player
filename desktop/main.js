/**
 * NEBULA 粒子音乐空间 —— 桌面版主进程
 *
 * 设计取舍：
 * 1) 不重写任何界面代码。web/ 那套（Three.js 粒子、UI、歌词）原样作为渲染层，
 *    主进程内直接跑中间层，窗口只是把 http://127.0.0.1:<port> 装进一个原生窗口。
 * 2) 两个 Node 服务怎么处理：
 *    - 中间层（server.js，8080）：**在主进程内 require**，同进程启动，不用另起。
 *    - 网易云 API（api/，3000）：是独立 Express 项目，用 Electron 自带的 Node
 *      （ELECTRON_RUN_AS_NODE）当子进程拉起来，这样打包后不依赖用户装 Node。
 * 3) 用户数据全部放 D 盘（用户规矩：C 盘不留东西）：userData、Cookie、截图、日志。
 *    打包后 asar 内是只读的，所以数据目录必须外置，这也顺带解决了写权限问题。
 */
'use strict';
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');

/* ----------------------------------------------------------- 路径与数据目录 */
const ROOT = path.resolve(__dirname, '..');                 // 项目根（web/ sources.js server.js api/）
const DATA_ROOT = process.env.NEBULA_DATA || 'D:\\NebulaPlayer';
const DATA_DIR = path.join(DATA_ROOT, 'data');
const isPackaged = app.isPackaged;

// 资源根：打包后在 resources/app（asar 解开或原样），开发时就是项目根
const RES = isPackaged ? path.join(process.resourcesPath, 'app') : ROOT;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// 用户数据（Chromium 缓存等）也挪到 D 盘——必须在 app ready 之前设置
app.setPath('userData', path.join(DATA_ROOT, 'userData'));
app.setPath('sessionData', path.join(DATA_ROOT, 'session'));
app.setPath('logs', path.join(DATA_ROOT, 'logs'));

// 让中间层把 Cookie / 截图写到数据目录（而不是只读的安装目录）
process.env.NCM_DATA_DIR = DATA_DIR;
process.env.NCM_ROOT = RES;

const PORT = Number(process.env.NEBULA_PORT || 8080);
const API_PORT = Number(process.env.NEBULA_API_PORT || 3000);
let mainWindow = null;
let apiProc = null;
let serverStarted = false;

/* ----------------------------------------------------------- 小工具 */
const log = (...a) => { try { console.log('[desktop]', ...a); } catch {} };

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(600, () => { s.destroy(); resolve(false); });
  });
}
async function waitPort(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await portInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/* ----------------------------------------------------------- 网易云 API 子进程 */
function startApiService() {
  const entry = path.join(RES, 'api', 'index.js');
  if (!fs.existsSync(entry)) { log('没找到 api/index.js，跳过网易云 API（QQ/酷狗 不受影响）'); return; }
  apiProc = spawn(process.execPath, [entry], {
    cwd: path.join(RES, 'api'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(API_PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  apiProc.stdout.on('data', (d) => log('api:', String(d).trim().slice(0, 160)));
  apiProc.stderr.on('data', (d) => log('api!', String(d).trim().slice(0, 160)));
  apiProc.on('exit', (code) => { log('api 子进程退出', code); apiProc = null; });
}

/* ----------------------------------------------------------- 中间层（同进程） */
function startMiddleLayer() {
  const entry = path.join(RES, 'server.js');
  if (!fs.existsSync(entry)) throw new Error('缺少 server.js：' + entry);
  process.env.PORT = String(PORT);
  process.env.API_BASE = process.env.API_BASE || `http://127.0.0.1:${API_PORT}`;
  process.env.NCM_WEB_DIR = path.join(RES, 'web');
  require(entry);          // 它自己会 listen，并在控制台打印启动信息
  serverStarted = true;
}

/* ----------------------------------------------------------- 窗口 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#000000',
    show: false,
    autoHideMenuBar: true,
    title: 'NEBULA 粒子音乐空间',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,        // 粒子动画不能因为窗口失焦就被降频
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外链走系统浏览器，别在应用窗口里开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ----------------------------------------------------------- 启动流程 */
async function boot() {
  Menu.setApplicationMenu(null);          // 去掉默认菜单栏，界面留给播放器

  const midUp = await portInUse(PORT);
  if (!midUp) {
    try { startMiddleLayer(); }
    catch (e) {
      dialog.showErrorBox('启动失败', '中间层起不来：' + e.message);
      app.quit(); return;
    }
    await waitPort(PORT, 15000);
  } else {
    log(`端口 ${PORT} 已有实例在跑，直接复用（开发时你自己的服务就占着它）`);
  }

  if (!(await portInUse(API_PORT))) {
    startApiService();
    // 等 API 真的起来再开窗。不等的后果实测过：窗口 1 秒就弹出来，
    // 而 API 还在启动 → 前端首屏拉歌单失败，直接显示"API 未就绪"，很像坏了
    const apiUp = await waitPort(API_PORT, 30000);
    log(apiUp ? `网易云 API 已就绪（:${API_PORT}）` : `⚠ 网易云 API 30s 未就绪，先开窗（QQ/酷狗 不受影响）`);
  } else {
    log(`端口 ${API_PORT} 已有网易云 API，直接复用`);
  }

  createWindow();
  log('窗口已就绪 →', `http://127.0.0.1:${PORT}/`);
  log('数据目录:', DATA_DIR);
}

// 单实例：重复双击就把已有窗口提到前面，不要开第二个（双开网关那种坑不重演）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => app.quit());      // Windows 上关窗即退出
  app.on('before-quit', () => { try { if (apiProc) apiProc.kill(); } catch {} });
}
