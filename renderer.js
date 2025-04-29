const { ipcRenderer } = require('electron');
const songInput     = document.getElementById('songInput');
const playlistInput = document.getElementById('playlistInput');
const formatSelect  = document.getElementById('formatSelect');
const folderPath    = document.getElementById('folderPath');
const browseBtn     = document.getElementById('browseBtn');
const downloadBtn   = document.getElementById('downloadBtn');
const stopBtn       = document.getElementById('stopBtn');
const loadingCt     = document.getElementById('loading-container');
const chronometerEl = document.getElementById('chronometer');
const progressCt    = document.getElementById('progressContainer');
const progressBar   = document.getElementById('downloadProgress');
const progressLabel = document.getElementById('progressLabel');
const logOutput     = document.getElementById('logOutput');

let chronoInterval, startTime;

browseBtn.addEventListener('click', async () => {
  const folder = await ipcRenderer.invoke('select-folder');
  if (folder) folderPath.value = folder;
});

songInput.addEventListener('input', () => {
  if (songInput.value) playlistInput.value = '';
});
playlistInput.addEventListener('input', () => {
  if (playlistInput.value) songInput.value = '';
});

downloadBtn.addEventListener('click', startDownload);
stopBtn.addEventListener('click', () => {
  ipcRenderer.send('cancel-download'); // hides UI
  stopChrono();
});

[songInput, playlistInput].forEach(el =>
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') startDownload();
  })
);

function startChrono() {
  startTime = Date.now();
  chronometerEl.textContent = '00:00:00';
  loadingCt.style.display = 'block';
  chronoInterval = setInterval(() => {
    const diff = Date.now() - startTime;
    const h = String(Math.floor(diff / 3600000)).padStart(2,'0');
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2,'0');
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2,'0');
    chronometerEl.textContent = `${h}:${m}:${s}`;
  }, 500);
}

function stopChrono() {
  clearInterval(chronoInterval);
  chronometerEl.textContent = '00:00:00';
  loadingCt.style.display = 'none';
}

function startDownload() {
  // 1) show spinner immediately
  startChrono();

  // 2) abort old job without hiding
  ipcRenderer.send('cancel-download', { suppressStop: true });

  // 3) collect inputs
  const songName    = songInput.value.trim();
  const playlistURL = playlistInput.value.trim();
  if (!songName && !playlistURL) {
    stopChrono();
    return;
  }

  // clear the opposite field
  if (songName) playlistInput.value = '';
  else          songInput.value    = '';

  // reset UI
  logOutput.innerHTML       = '';
  progressBar.value         = 0;
  progressLabel.textContent = '0%';
  progressCt.style.display  = 'block';

  downloadBtn.disabled = true;
  stopBtn.disabled     = false;

  // 4) fire it off
  ipcRenderer.send('download-song', {
    songName,
    playlistURL: songName ? '' : playlistURL,
    format: formatSelect.value,
    folder: folderPath.value.trim()
  });
}

ipcRenderer.on('download-progress', (_, pct) => {
  progressBar.value = pct;
  progressLabel.textContent = `${pct}%`;
});

ipcRenderer.on('log-message', (_, msg) => {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logOutput.appendChild(line);
  logOutput.scrollTop = logOutput.scrollHeight;
});

ipcRenderer.on('stop-loading', () => {
  stopChrono();
  progressLabel.textContent = 'Done';
  downloadBtn.disabled = false;
  // Stop remains enabled
});
