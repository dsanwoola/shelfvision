// ShelfVision — camera access helpers.

let currentStream = null;

export async function startCamera(videoEl) {
  stopCamera(videoEl);
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  };
  currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = currentStream;
  await videoEl.play();
  return currentStream;
}

export function stopCamera(videoEl) {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
  if (videoEl) videoEl.srcObject = null;
}

export function isCameraActive() {
  return !!currentStream;
}
