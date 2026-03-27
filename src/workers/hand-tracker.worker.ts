/// <reference lib="WebWorker" />

import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { assetUrl } from "@/lib/assets";
import { createEmptyInteractionState, TrackingStateEngine } from "@/lib/hand-tracking/tracker-core";
import type { WorkerRequest, WorkerResponse } from "@/lib/hand-tracking/worker-protocol";

declare const self: DedicatedWorkerGlobalScope;

type WorkerImportGlobal = DedicatedWorkerGlobalScope & {
  import?: (url: string) => Promise<unknown>;
  importScripts?: (...urls: string[]) => void;
};

async function importClassicScript(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch worker dependency: ${url} (${response.status})`);
  }

  const source = await response.text();
  (0, eval)(`${source}\n//# sourceURL=${url}`);
}

// MediaPipe's wasm loader expects either `importScripts(...)` or a `self.import(...)`
// helper able to load classic scripts into the worker global scope.
const workerGlobal = self as WorkerImportGlobal;
workerGlobal.importScripts ??= (() => {
  throw new TypeError("Module worker fallback to self.import");
}) as typeof importScripts;
workerGlobal.import ??= (url: string) => importClassicScript(url);

let landmarker: HandLandmarker | null = null;
let engine: TrackingStateEngine | null = null;
let paused = false;

function postMessageToMain(message: WorkerResponse) {
  self.postMessage(message);
}

async function initWorker(message: Extract<WorkerRequest, { type: "init" }>) {
  if (landmarker && engine) {
    postMessageToMain({
      type: "ready",
      backend: "worker",
    });
    return;
  }

  engine = new TrackingStateEngine({
    qualityTier: message.qualityTier,
    reducedMotion: message.reducedMotion,
    detailedLandmarksEnabled: message.detailedLandmarksEnabled ?? false,
  });

  const vision = await FilesetResolver.forVisionTasks(assetUrl("mediapipe/wasm/"));

  try {
    landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: assetUrl("models/hand_landmarker.task"),
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.45,
    });
  } catch {
    landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: assetUrl("models/hand_landmarker.task"),
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.45,
    });
  }

  postMessageToMain({
    type: "ready",
    backend: "worker",
  });
}

async function handleFrame(message: Extract<WorkerRequest, { type: "frame" }>) {
  if (!landmarker || !engine || paused) {
    message.bitmap.close();
    return;
  }

  const startedAt = performance.now();

  try {
    const result = landmarker.detectForVideo(message.bitmap, message.timestamp);
    const trackingMs = performance.now() - startedAt;
    const interaction = engine.processResult(result, message.timestamp);

    postMessageToMain({
      type: "trackingResult",
      frameId: message.frameId,
      trackingMs,
      interaction,
    });
  } finally {
    message.bitmap.close();
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case "init":
        await initWorker(message);
        break;
      case "frame":
        await handleFrame(message);
        break;
      case "setViewportMapping":
        engine?.setViewportMapping(message.mapping);
        break;
      case "setQualityTier":
        engine?.setQualityTier(message.qualityTier);
        break;
      case "setDetailedLandmarksEnabled":
        engine?.setDetailedLandmarksEnabled(message.enabled);
        break;
      case "pause":
        paused = true;
        break;
      case "resume":
        paused = false;
        break;
      case "reset":
        postMessageToMain({
          type: "reset",
          interaction: engine?.reset(message.now) ?? createEmptyInteractionState(message.now),
        });
        break;
      case "dispose":
        paused = true;
        landmarker?.close();
        landmarker = null;
        engine = null;
        self.close();
        break;
      default:
        break;
    }
  } catch (error) {
    if (message.type === "frame" && message.bitmap) {
      try {
        message.bitmap.close();
      } catch {
        // noop
      }
    }

    postMessageToMain({
      type: "error",
      phase: message.type === "init" ? "init" : "runtime",
      message: error instanceof Error ? error.message : "Worker hand tracker failed.",
    });
  }
};
