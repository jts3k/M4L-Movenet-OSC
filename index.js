// index.js

const MaxAPI = require('max-api');
const io = require('socket.io')();
const { spawn } = require('child_process');
const path = require('path');

// Spawn Electron process
const electronPath = require('electron');
const appPath = path.join(__dirname, '.');
const child = spawn(electronPath, [appPath]);

io.on('connection', (socket) => {
  console.log('Socket is connected with Electron App');

  // Relay camera list from Electron app to Max
  socket.on('cameraList', (data) => {
    console.log('Received camera list from Electron:', data);
    MaxAPI.outlet('cameraList', data); // Send data to Max as a dictionary
  });

  // Relay pose data from Electron app to Max
  socket.on('poseData', (data) => {
    MaxAPI.outlet('poseData', data); // Send pose data to Max
  });

  // Listen for messages from Max to change camera
  MaxAPI.addHandler('changeCamera', (cameraIndex) => {
    console.log(`Received changeCamera request for index: ${cameraIndex}`);
    socket.emit('changeCamera', parseInt(cameraIndex));
  });

  // Listen for 'setMaxNumPoses' messages from Max
  MaxAPI.addHandler('setMaxNumPoses', (value) => {
    console.log(`Received setMaxNumPoses request with value: ${value}`);
    socket.emit('setMaxNumPoses', parseInt(value));
  });

  // Listen for 'resetPersonId' messages from Max
  MaxAPI.addHandler('resetPersonId', () => {
    console.log('Received resetPersonId request');
    socket.emit('resetPersonId');
  });

  // Listen for 'setDistanceThreshold' messages from Max
  MaxAPI.addHandler('setDistanceThreshold', (value) => {
    console.log(`Received setDistanceThreshold request with value: ${value}`);
    socket.emit('setDistanceThreshold', parseFloat(value));
  });
});

io.listen(4512); // Listen on port 4512

// Ensure the Electron app is terminated when this process exits
process.on('exit', () => {
  child.kill();
});