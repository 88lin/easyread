const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

let backend;
let mainWindow;

function projectRoot() {
  return path.resolve(__dirname, "..");
}

function packagedBackend() {
  const name = process.platform === "win32" ? "easyread-backend.exe" : "easyread-backend";
  return path.join(process.resourcesPath, "backend", name);
}

function backendCommand() {
  if (app.isPackaged) {
    const executable = packagedBackend();
    if (!fs.existsSync(executable)) {
      throw new Error(`找不到打包后的 EasyRead 后端：${executable}`);
    }
    return { command: executable, args: ["serve", "--port", "0"], cwd: app.getPath("userData") };
  }

  const root = projectRoot();
  const python = process.platform === "win32"
    ? path.join(root, ".venv", "Scripts", "python.exe")
    : path.join(root, ".venv", "bin", "python");
  const command = fs.existsSync(python) ? python : (process.platform === "win32" ? "python" : "python3");
  return { command, args: ["-m", "easyread", "serve", "--port", "0"], cwd: root };
}

function startBackend() {
  const launch = backendCommand();
  const env = { ...process.env, PYTHONUTF8: "1" };
  if (app.isPackaged) {
    env.EASYREAD_HOME = app.getPath("userData");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`EasyRead 后端启动超时。${output.slice(-500)}`));
    }, 30000);

    backend = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    backend.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/EasyRead\s+已启动：\s*(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) finish(resolve, match[1]);
    });
    backend.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    backend.once("error", (error) => finish(reject, error));
    backend.once("exit", (code, signal) => {
      if (!settled) finish(reject, new Error(`EasyRead 后端退出（code=${code}, signal=${signal}）。${output.slice(-500)}`));
    });
  });
}

function stopBackend() {
  if (backend && !backend.killed) {
    if (process.platform === "win32") {
      // PyInstaller's one-file launcher creates a child process. Killing only
      // the launcher would leave the local HTTP service running after exit.
      try {
        execFileSync("taskkill", ["/pid", String(backend.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch (_) {
        // The process may already have exited while the window was closing.
      }
    } else {
      backend.kill();
    }
    backend = undefined;
  }
}

async function createWindow() {
  let url;
  try {
    url = await startBackend();
  } catch (error) {
    dialog.showErrorBox("EasyRead 启动失败", error.message);
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 680,
    icon: path.join(__dirname, "assets", "icon.ico"),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = undefined; });
  await mainWindow.loadURL(url);
}

// Keep the web application's own header at the top of the content area. The
// default Electron File/Edit/View/Window strip would otherwise create a second
// toolbar row above it.
Menu.setApplicationMenu(null);

app.whenReady().then(createWindow);
app.on("before-quit", stopBackend);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
process.on("exit", stopBackend);
