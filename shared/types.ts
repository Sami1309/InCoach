export type AgentStage =
  | "intent"
  | "researcher"
  | "youtube"
  | "videos"
  | "validator"
  | "compositor"
  | "done"
  | "error";

export interface AgentEvent {
  ts: number;
  stage: AgentStage;
  agent?: string;
  model?: string;
  query?: string;
  status: "start" | "thinking" | "result" | "error";
  message: string;
  data?: unknown;
}

export interface Intent {
  activity: string;
  goal: string;
  skillLevel: "beginner" | "intermediate" | "advanced" | "unknown";
  environment: string;
  equipment: string[];
  durationMinutes: number;
  constraints: string[];
  painFlags: string[];
  successMetric: string;
  needsSafetyScreen: boolean;
}

export interface DrillStep {
  title: string;
  cue: string;
  reps: number;
  durationSec: number;
  focusLandmark?: string | null;
}

export interface DrillMoment {
  t: number;
  caption: string;
  thumb: string;
}

export interface DrillVideo {
  stepIndex: number;
  query: string;
  videoId: string;
  url: string;
  title?: string;
  thumb: string;
  start?: number;
  moments?: DrillMoment[];
}

export interface Routine {
  title: string;
  summary: string;
  estimateMinutes: number;
  steps: DrillStep[];
  cues: string[];
  source?: { url?: string | null; note?: string | null } | null;
}

export interface ValidatorDiff {
  field: string;
  before: string;
  after: string;
  reason: string;
}

export interface CompileResult {
  intent: Intent;
  routine: Routine;
  validated: Routine;
  diffs: ValidatorDiff[];
  videos: DrillVideo[];
  youtubeUrl?: string;
  sources: string[];
}
