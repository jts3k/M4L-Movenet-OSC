// main.js

const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    alwaysOnTop: true, // Add this line to make the window always on top
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  win.loadFile('camera.html');
}

// Start the Electron app
app.whenReady().then(createWindow);

// Handle window all closed (macOS specific)
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// Handle app activation (macOS specific)
app.on('activate', function () {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});