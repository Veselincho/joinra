const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { connect } = require('puppeteer-real-browser');

let mainWindow, globalBrowser, globalYoutubePage;
let currentProc = null;
let currentTaskId = 0;
let cancelledTaskId = 0;

function logMessage(msg) {
  if (mainWindow) mainWindow.webContents.send('log-message', msg);
}
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    currentProc = spawn('yt-dlp', args);
    let stdout = '';
    currentProc.stdout.on('data', d => (stdout += d.toString()));
    currentProc.stderr.on('data', d => logMessage(d.toString().trim()));
    currentProc.on('close', code => {
      currentProc = null;
      code === 0 ? resolve(stdout) : reject(new Error(`yt-dlp exited with code ${code}`));
    });
    currentProc.on('error', reject);
  });
}

async function getVideoTitle(videoUrl, taskId) {
  if (taskId <= cancelledTaskId) throw new Error('cancelled');
  try {
    const jsonStr = await runYtDlp(['--no-playlist', '-j', videoUrl]);
    if (taskId <= cancelledTaskId) throw new Error('cancelled');
    return JSON.parse(jsonStr).title || videoUrl;
  } catch {
    return videoUrl;
  }
}

ipcMain.handle('select-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (!canceled) {
    logMessage(`📁 Selected folder: ${filePaths[0]}`);
    return filePaths[0];
  }
  return null;
});

// cancel-download now only hides UI when suppressStop=false
ipcMain.on('cancel-download', (_, { suppressStop = false } = {}) => {
  cancelledTaskId = currentTaskId;
  if (currentProc) {
    currentProc.kill('SIGINT');
    logMessage('🛑 Download cancelled by user');
  }
  if (!suppressStop) {
    mainWindow.webContents.send('stop-loading');
  }
});

async function downloadMedia({ songName, playlistURL, format, folder }, taskId) {
  if (taskId <= cancelledTaskId) return;

  const fmtArgs = [];
  switch (format) {
    case 'mp3':
      fmtArgs.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
      break;
    case 'flac':
      fmtArgs.push('-x', '--audio-format', 'flac');
      break;
    case 'wav':
      fmtArgs.push('-x', '--audio-format', 'wav');
      break;
  }
  const baseOutput = folder
    ? ['-o', path.join(folder, '%(title)s.%(ext)s')]
    : [];

  if (songName) {
    let url = songName.startsWith('http')
      ? songName
      : await searchFirstResultURL(songName);
    if (taskId <= cancelledTaskId) return;

    const title = await getVideoTitle(url, taskId);
    if (taskId <= cancelledTaskId) return;

    logMessage(`⬇️ Downloading: ${title}`);
    try {
      await runYtDlp(['--no-playlist', ...fmtArgs, ...baseOutput, url]);
      logMessage('✅ Finished single download');
      mainWindow.webContents.send('download-progress', 100);
    } catch (err) {
      if (taskId > cancelledTaskId) logMessage(`❌ Failed ${title}: ${err.message}`);
    }
  } else if (playlistURL) {
    logMessage('🎶 Fetching playlist video IDs...');
    let idList = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (taskId <= cancelledTaskId) return;
      try {
        idList = await runYtDlp(['--flat-playlist', '--get-id', playlistURL]);
        break;
      } catch {
        logMessage(`⚠️ ID fetch attempt ${attempt} failed, retrying...`);
        await delay(2000);
      }
    }
    if (taskId <= cancelledTaskId) return;

    const ids = idList.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!ids.length) {
      logMessage('❌ No video IDs found in playlist');
      mainWindow.webContents.send('stop-loading');
      return;
    }

    for (let i = 0; i < ids.length; i++) {
      if (taskId <= cancelledTaskId) break;
      const videoUrl = `https://www.youtube.com/watch?v=${ids[i]}`;
      const title = await getVideoTitle(videoUrl, taskId);
      if (taskId <= cancelledTaskId) break;

      logMessage(`⬇️ Downloading (${i + 1}/${ids.length}): ${title}`);
      try {
        await runYtDlp(['--no-playlist', ...fmtArgs, ...baseOutput, videoUrl]);
        logMessage(`✅ Finished ${i + 1}/${ids.length}`);
      } catch (err) {
        if (taskId <= cancelledTaskId) break;
        logMessage(`❌ Failed ${title}: ${err.message}`);
      }

      const overallPct = Math.floor(((i + 1) / ids.length) * 100);
      mainWindow.webContents.send('download-progress', overallPct);

      if (i < ids.length - 1) {
        logMessage('⌛ Waiting 1 minute before next...');
        await delay(60_000);
      }
    }

    if (taskId > cancelledTaskId) logMessage('🎉 All songs downloaded.');
  }

  mainWindow.webContents.send('stop-loading');
}

async function launchBrowser() {
  const conn = await connect({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  globalBrowser = conn.browser;
  globalYoutubePage = await globalBrowser.newPage();
  await globalYoutubePage.setViewport({ width: 1920, height: 1080 });
}

async function searchFirstResultURL(term) {
  logMessage(`🔍 Searching for: ${term}`);
  await globalYoutubePage.goto(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(term)}`
  );
  const video = await globalYoutubePage.waitForSelector(
    "xpath/(//a[@id='video-title'])[1]", { timeout: 0 }
  );
  const href = await video.getProperty('href').then(p => p.jsonValue());
  logMessage(`✅ Found URL: ${href}`);
  return href;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady()
  .then(() => {
    ipcMain.removeAllListeners('download-song');
    ipcMain.on('download-song', (_, payload) => {
      // tear down any existing job
      cancelledTaskId = currentTaskId;
      if (currentProc) currentProc.kill('SIGINT');
      // **<- removed** mainWindow.webContents.send('stop-loading');

      currentTaskId++;
      downloadMedia(payload, currentTaskId).catch(err => {
        logMessage(`❌ Error: ${err.message}`);
        mainWindow.webContents.send('stop-loading');
      });
    });
  })
  .then(createWindow)
  .then(launchBrowser)
  .catch(console.error);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
