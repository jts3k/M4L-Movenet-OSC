// camera.js

// Access socket.io client from the global scope
const socket = io('http://localhost:4512');

// Get references to HTML elements
const videoElement = document.getElementById('video');
const canvasElement = document.getElementById('canvas');
const canvasCtx = canvasElement.getContext('2d');

// Dimensions (initialized to default values)
let width = 640;
let height = 480;

// Set initial canvas and video dimensions
videoElement.width = width;
videoElement.height = height;
canvasElement.width = width;
canvasElement.height = height;

// Load the MoveNet model
let detector;
let detectorConfig = { modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING };

async function loadModel() {
  detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, detectorConfig);
  console.log('MoveNet model loaded');
}

// Function to start video stream
async function setupCamera(deviceId = null) {
  const constraints = {
    audio: false,
    video: {
      width: width,
      height: height,
      ...(deviceId && { deviceId: { exact: deviceId } }),
    },
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoElement.srcObject = stream;

  return new Promise((resolve) => {
    videoElement.onloadedmetadata = () => {
      // Update dimensions based on the camera stream
      width = videoElement.videoWidth;
      height = videoElement.videoHeight;
      videoElement.width = width;
      videoElement.height = height;
      canvasElement.width = width;
      canvasElement.height = height;

      videoElement.play();
      resolve();
    };
  });
}

let cameraList = {}; // Store the camera list as a dictionary

// Function to list available video devices
async function listVideoDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter((device) => device.kind === 'videoinput');
    return videoDevices;
  } catch (error) {
    console.error('Error enumerating devices:', error);
    return [];
  }
}

// Send the list of cameras to Max
async function sendCameraList() {
  const videoDevices = await listVideoDevices();
  const deviceDict = {};
  videoDevices.forEach((device, index) => {
    deviceDict[index] = {
      label: device.label || `Camera ${index + 1}`,
      deviceId: device.deviceId,
    };
  });
  cameraList = deviceDict; // Store the device list
  socket.emit('cameraList', deviceDict); // Send as a dictionary
}

// Listen for 'changeCamera' messages from Max
socket.on('changeCamera', async (cameraIndex) => {
  console.log(`Switching to camera with index: ${cameraIndex}`);
  const device = cameraList[cameraIndex];
  if (device) {
    await changeCamera(device.deviceId);
  } else {
    console.error(`No camera found at index ${cameraIndex}`);
  }
});

let maxNumPoses = 5; // Default maximum number of poses

// Listen for 'setMaxNumPoses' messages from Max
socket.on('setMaxNumPoses', (value) => {
  console.log(`Setting maxNumPoses to: ${value}`);
  maxNumPoses = parseInt(value);
});

// Default distance threshold for tracking
let distanceThreshold = 0.5; // Adjust this value as needed

// Listen for 'setDistanceThreshold' messages from Max
socket.on('setDistanceThreshold', (value) => {
  console.log(`Setting distanceThreshold to: ${value}`);
  distanceThreshold = parseFloat(value);
});

// Listen for 'resetPersonId' messages from Max
socket.on('resetPersonId', () => {
  console.log('Resetting person IDs');
  resetTracking();
});

// Function to change the camera
async function changeCamera(deviceId) {
  try {
    // Stop any existing video tracks
    if (videoElement.srcObject) {
      videoElement.srcObject.getTracks().forEach((track) => track.stop());
    }

    await setupCamera(deviceId);

    // Reset tracking variables when camera changes
    resetTracking();
  } catch (error) {
    console.error('Error changing camera:', error);
  }
}

let animationFrameId; // To track the animation frame request ID

// Tracking variables
let trackedPersons = [];
let nextPersonId = 0;
const maxMissingFrames = 5; // Number of frames to wait before removing a person

// Function to reset tracking variables
function resetTracking() {
  trackedPersons = [];
  nextPersonId = 0;
}

// Import the munkres-js library for the Hungarian algorithm
// Ensure that the munkres-js library is included in your HTML file via a script tag
// <script src="path/to/munkres.js"></script>

async function renderResult() {
  if (
    videoElement.readyState < 2 ||
    videoElement.paused ||
    videoElement.ended ||
    width === 0 ||
    height === 0
  ) {
    await new Promise((resolve) => {
      videoElement.onplaying = () => {
        resolve();
      };
    });
  }

  // Run pose detection
  const poses = await detector.estimatePoses(videoElement, {
    maxPoses: maxNumPoses,
    flipHorizontal: false,
  });

  // Clear canvas
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  // Draw the video frame
  canvasCtx.drawImage(videoElement, 0, 0, width, height);

  // Normalize keypoints
  const normalizedPoses = poses.map((pose) => ({
    keypoints: pose.keypoints.map((keypoint) => ({
      x: keypoint.x / width,
      y: keypoint.y / height,
      score: keypoint.score,
      name: keypoint.name,
    })),
  }));

  // Update tracking using the modified tracking algorithm
  updateTracking(normalizedPoses);

  // Draw poses and send data to Max/MSP
  trackedPersons.forEach((person) => {
    // Draw keypoints and skeleton using pixel coordinates
    const scaledKeypoints = person.keypoints.map((keypoint) => ({
      x: keypoint.x * width,
      y: keypoint.y * height,
      score: keypoint.score,
      name: keypoint.name,
    }));

    drawKeypoints(scaledKeypoints, 0.3, canvasCtx);
    drawSkeleton(scaledKeypoints, 0.3, canvasCtx);

    // Send normalized pose data to Max with consistent personId
    socket.emit('poseData', { personId: person.id, keypoints: person.keypoints });
  });

  animationFrameId = requestAnimationFrame(renderResult);
}

// Updated tracking function using centroid and keypoint distances
function updateTracking(detectedPoses) {
  // Step 1: Compute cost matrix based on distances between detected poses and tracked persons
  const costMatrix = [];
  detectedPoses.forEach((detectedPose) => {
    const costs = trackedPersons.map((person) => {
      const cost = computeCost(detectedPose, person);
      return cost;
    });
    costMatrix.push(costs);
  });

  // Step 2: Solve the assignment problem using the Hungarian algorithm
  const assignments = [];
  if (costMatrix.length > 0 && costMatrix[0].length > 0) {
    const munkres = new Munkres();
    const indices = munkres.compute(costMatrix);

    indices.forEach(([detectedIndex, trackerIndex]) => {
      const cost = costMatrix[detectedIndex][trackerIndex];
      if (cost < distanceThreshold) {
        assignments.push([detectedIndex, trackerIndex]);
      }
    });
  }

  // Step 3: Update tracked persons with assigned detections
  const updatedTrackedPersons = [];
  const assignedTrackerIndices = new Set();

  assignments.forEach(([detectedIndex, trackerIndex]) => {
    const detectedPose = detectedPoses[detectedIndex];
    const person = trackedPersons[trackerIndex];

    person.keypoints = detectedPose.keypoints;
    person.lastSeen = Date.now();
    person.missingFrames = 0;

    updatedTrackedPersons.push(person);
    assignedTrackerIndices.add(trackerIndex);
  });

  // Step 4: Handle unmatched tracked persons (those who were not assigned any detection)
  trackedPersons.forEach((person, index) => {
    if (!assignedTrackerIndices.has(index)) {
      person.missingFrames += 1;
      if (person.missingFrames <= maxMissingFrames) {
        // Keep the person in the tracking list
        updatedTrackedPersons.push(person);
      } else {
        console.log(`Person ID ${person.id} removed after missing for ${person.missingFrames} frames.`);
      }
    }
  });

  // Step 5: Handle new detections that weren't assigned to any tracked person
  const assignedDetectionIndices = new Set(assignments.map(([detectedIndex]) => detectedIndex));
  detectedPoses.forEach((detectedPose, index) => {
    if (!assignedDetectionIndices.has(index)) {
      // Create new person
      const newPerson = {
        id: nextPersonId++,
        keypoints: detectedPose.keypoints,
        lastSeen: Date.now(),
        missingFrames: 0,
      };
      updatedTrackedPersons.push(newPerson);
      console.log(`New person detected with ID ${newPerson.id}.`);
    }
  });

  // Update the global trackedPersons list
  trackedPersons = updatedTrackedPersons;
}

// Function to compute cost between detected pose and tracked person
function computeCost(detectedPose, trackedPerson) {
  // Compute centroid distances
  const centroidA = computeCentroid(detectedPose.keypoints);
  const centroidB = computeCentroid(trackedPerson.keypoints);

  if (!centroidA || !centroidB) {
    return Infinity;
  }

  const dx = centroidA.x - centroidB.x;
  const dy = centroidA.y - centroidB.y;
  const centroidDistance = Math.sqrt(dx * dx + dy * dy);

  // Compute average keypoint distance
  const keypointDistance = computeAverageKeypointDistance(detectedPose.keypoints, trackedPerson.keypoints);

  // Combine distances with weights
  const alpha = 0.1; // Weight for centroid distance
  const beta = 0.9;  // Weight for keypoint distance

  return alpha * centroidDistance + beta * keypointDistance;
}

// Function to compute centroid of keypoints
function computeCentroid(keypoints) {
  let sumX = 0;
  let sumY = 0;
  let count = 0;

  keypoints.forEach((keypoint) => {
    if (keypoint.score > 0.3) {
      sumX += keypoint.x;
      sumY += keypoint.y;
      count += 1;
    }
  });

  if (count === 0) {
    return null;
  }

  return { x: sumX / count, y: sumY / count };
}

// Function to compute average keypoint distance between two poses
function computeAverageKeypointDistance(keypointsA, keypointsB) {
  let totalDistance = 0;
  let count = 0;

  keypointsA.forEach((keypointA, i) => {
    const keypointB = keypointsB[i];
    if (keypointA.score > 0.3 && keypointB.score > 0.3) {
      const dx = keypointA.x - keypointB.x;
      const dy = keypointA.y - keypointB.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      totalDistance += distance;
      count += 1;
    }
  });

  return count > 0 ? totalDistance / count : Infinity;
}

// Drawing functions
function drawKeypoints(keypoints, minConfidence, ctx) {
  keypoints.forEach((keypoint) => {
    if (keypoint.score >= minConfidence) {
      const { x, y } = keypoint;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, 2 * Math.PI);
      ctx.fillStyle = 'Red';
      ctx.fill();
    }
  });
}

function drawSkeleton(keypoints, minConfidence, ctx) {
  const adjacentKeyPoints = poseDetection.util.getAdjacentPairs(poseDetection.SupportedModels.MoveNet);
  adjacentKeyPoints.forEach(([i, j]) => {
    const kp1 = keypoints[i];
    const kp2 = keypoints[j];

    if (kp1.score >= minConfidence && kp2.score >= minConfidence) {
      ctx.beginPath();
      ctx.moveTo(kp1.x, kp1.y);
      ctx.lineTo(kp2.x, kp2.y);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'Green';
      ctx.stroke();
    }
  });
}

// Initial setup
(async () => {
  await loadModel(); // Load MoveNet model
  await sendCameraList(); // Send the initial list of cameras to Max
  await setupCamera(); // Start with the default camera
  renderResult(); // Start pose estimation
})();