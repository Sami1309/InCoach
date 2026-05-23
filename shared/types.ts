export type AgentStage =
  | "intent"
  | "researcher"
  | "youtube"
  | "validator"
  | "compositor"
  | "done"
  | "error";

export interface AgentEvent {
  ts: number;
  stage: AgentStage;
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
  focusLandmark?: string;
}

export interface Routine {
  title: string;
  summary: string;
  estimateMinutes: number;
  steps: DrillStep[];
  cues: string[];
  source?: { url?: string; note?: string };
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
  youtubeUrl?: string;
  sources: string[];
}
