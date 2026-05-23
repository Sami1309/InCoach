import {
  PoseLandmarker,
  FilesetResolver,
  DrawingUtils,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

export interface PoseTick {
  landmarks: NormalizedLandmark[];
  swayScore: number;
  sternumX: number;
}

let landmarker: PoseLandmarker | null = null;

export async function initPose(): Promise<PoseLandmarker> {
  if (landmarker) return landmarker;
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
  );
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.6,
    minPosePresenceConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });
  return landmarker;
}

export function startPoseLoop(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  onTick: (tick: PoseTick) => void,
): () => void {
  let raf = 0;
  let cancelled = false;
  let baselineSternum: number | null = null;

  const ctx = canvas.getContext("2d")!;
  const drawing = new DrawingUtils(ctx);

  const loop = () => {
    if (cancelled) return;
    if (video.readyState >= 2 && landmarker) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ts = performance.now();
      const result = landmarker.detectForVideo(video, ts);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (result.landmarks && result.landmarks.length > 0) {
        const lm = result.landmarks[0];
        drawing.drawLandmarks(lm, {
          radius: 3,
          color: "#7df9c4",
          lineWidth: 1,
        });
        drawing.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, {
          color: "rgba(105, 183, 255, 0.8)",
          lineWidth: 2,
        });
        const lShoulder = lm[11];
        const rShoulder = lm[12];
        const sternumX = (lShoulder.x + rShoulder.x) / 2;
        if (baselineSternum == null) baselineSternum = sternumX;
        const swayScore = Math.round((sternumX - baselineSternum) * 1000) / 10;
        onTick({ landmarks: lm, swayScore, sternumX });
      }
    }
    raf = requestAnimationFrame(loop);
  };
  loop();
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
  };
}
