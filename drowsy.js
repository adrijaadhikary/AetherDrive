/* AetherDrive Drowsiness Detection using MediaPipe FaceMesh */

let faceMesh = null;
let camera = null;
let closedEyeStart = null;
const DROWSY_THRESHOLD_MS = 1500; // Trigger alarm after 1.5 seconds of closed eyes

// Helper to update status readout safely
function setStatusText(msg) {
  const readout = document.getElementById("drowsyReadout") || document.getElementById("ciStatus");
  if (readout) readout.textContent = msg;
}

// Helper to calculate 2D Euclidean distance between landmark points
function distance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

// Calculate Eye Aspect Ratio (EAR) using MediaPipe 468-point landmarks
function getEAR(landmarks) {
  // Left eye landmarks: Top/Bottom pairs (159,145), (158,144), Horizontal corners (33,133)
  const leftV1 = distance(landmarks[159], landmarks[145]);
  const leftV2 = distance(landmarks[158], landmarks[144]);
  const leftH  = distance(landmarks[33], landmarks[133]);
  const leftEAR = (leftV1 + leftV2) / (2.0 * leftH);

  // Right eye landmarks: Top/Bottom pairs (386,374), (385,373), Horizontal corners (362,263)
  const rightV1 = distance(landmarks[386], landmarks[374]);
  const rightV2 = distance(landmarks[385], landmarks[373]);
  const rightH  = distance(landmarks[362], landmarks[263]);
  const rightEAR = (rightV1 + rightV2) / (2.0 * rightH);

  return (leftEAR + rightEAR) / 2.0;
}

// MediaPipe frame processing callback
function onResults(results) {
  if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
    setStatusText("No face detected in view");
    return;
  }

  const landmarks = results.multiFaceLandmarks[0];
  const ear = getEAR(landmarks);

  // EAR threshold < 0.20 indicates closed eyelids
  if (ear < 0.20) {
    if (!closedEyeStart) closedEyeStart = Date.now();
    const duration = Date.now() - closedEyeStart;

    if (duration > DROWSY_THRESHOLD_MS) {
      setStatusText("DANGER: DROWSINESS DETECTED!");
      if (typeof alarmOn === "function") alarmOn();
      if (window.AetherDrive?.setAlertness) window.AetherDrive.setAlertness(20);
    }
  } else {
    closedEyeStart = null;
    setStatusText("Driver Alert: Awake");
    if (typeof alarmOff === "function") alarmOff();
    if (window.AetherDrive?.setAlertness) window.AetherDrive.setAlertness(100);
  }
}

// Start MediaPipe camera feed and model
async function startDetection() {
  const videoElement = document.getElementById("cam") || document.querySelector("video");
  if (!videoElement) {
    console.error("Video element not found");
    return;
  }

  setStatusText("Initializing FaceMesh tracking...");

  faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  faceMesh.onResults(onResults);

  camera = new Camera(videoElement, {
    onFrame: async () => {
      await faceMesh.send({ image: videoElement });
    },
    width: 640,
    height: 480
  });

  await camera.start();
  setStatusText("Camera active. Monitoring alertness...");
}

// Stop camera feed and reset state
function stopDetection() {
  if (camera) {
    camera.stop();
    camera = null;
  }
  closedEyeStart = null;
  setStatusText("Camera stopped.");
  if (typeof alarmOff === "function") alarmOff();
  if (window.AetherDrive?.setAlertness) window.AetherDrive.setAlertness(100);
}

// Bind UI action controls
document.addEventListener("DOMContentLoaded", () => {
  const startBtn = document.getElementById("startCam") || document.getElementById("startcam");
  const stopBtn = document.getElementById("stopCam") || document.getElementById("stopcam");

  if (startBtn) startBtn.addEventListener("click", startDetection);
  if (stopBtn) stopBtn.addEventListener("click", stopDetection);
});