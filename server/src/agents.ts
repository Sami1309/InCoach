import { z } from "zod";
import { generateJSON, generateGrounded, analyzeYouTube } from "./gemini.js";
import type {
  AgentEvent,
  CompileResult,
  Intent,
  Routine,
  ValidatorDiff,
} from "../../shared/types.js";

type Emit = (e: Omit<AgentEvent, "ts">) => void;

const IntentSchema = z.object({
  activity: z.string(),
  goal: z.string(),
  skillLevel: z.enum(["beginner", "intermediate", "advanced", "unknown"]),
  environment: z.string(),
  equipment: z.array(z.string()),
  durationMinutes: z.number(),
  constraints: z.array(z.string()),
  painFlags: z.array(z.string()),
  successMetric: z.string(),
  needsSafetyScreen: z.boolean(),
});

const DrillStepSchema = z.object({
  title: z.string(),
  cue: z.string(),
  reps: z.number(),
  durationSec: z.number(),
  focusLandmark: z.string().nullish(),
});

const RoutineSchema = z.object({
  title: z.string(),
  summary: z.string(),
  estimateMinutes: z.number(),
  steps: z.array(DrillStepSchema),
  cues: z.array(z.string()),
  source: z
    .object({ url: z.string().nullish(), note: z.string().nullish() })
    .nullish(),
});

const ValidatorSchema = z.object({
  validated: RoutineSchema,
  diffs: z.array(
    z.object({
      field: z.string(),
      before: z.string(),
      after: z.string(),
      reason: z.string(),
    }),
  ),
});

export async function runPipeline(
  transcript: string,
  emit: Emit,
  opts: { youtubeUrl?: string; sport?: string } = {},
): Promise<CompileResult> {
  const sport = opts.sport ?? "golf";

  emit({ stage: "intent", status: "start", message: "Parsing intent" });
  const intent: Intent = await generateJSON(
    `Parse this ${sport} coaching request into a movement intent. Request: "${transcript}". Default activity to ${sport} if unspecified.`,
    IntentSchema,
  );
  emit({
    stage: "intent",
    status: "result",
    message: `Goal: ${intent.goal}`,
    data: intent,
  });

  emit({
    stage: "researcher",
    status: "start",
    message: "Searching drills with Google grounding",
  });
  const research = await generateGrounded(
    `Find 2 to 3 safe, high quality ${sport} drills that target: ${intent.goal}. Skill: ${intent.skillLevel}. Equipment: ${intent.equipment.join(", ") || "none"}. Constraints: ${intent.constraints.join(", ") || "none"}. Provide concrete cues.`,
  );
  emit({
    stage: "researcher",
    status: "result",
    message: `Found ${research.sources.length} sources`,
    data: { sources: research.sources, snippet: research.text.slice(0, 280) },
  });

  let youtubeNotes = "";
  if (opts.youtubeUrl) {
    emit({
      stage: "youtube",
      status: "start",
      message: `Ingesting ${opts.youtubeUrl}`,
    });
    youtubeNotes = await analyzeYouTube(
      opts.youtubeUrl,
      `Extract setup steps, key verbal cues, and corrective adaptations from this ${sport} video. Return as a short structured list.`,
    );
    emit({
      stage: "youtube",
      status: "result",
      message: "Extracted drill cues from video",
      data: { notes: youtubeNotes.slice(0, 320), url: opts.youtubeUrl },
    });
  }

  emit({
    stage: "compositor",
    status: "start",
    message: "Compiling routine",
  });
  const routine: Routine = await generateJSON(
    `Compose a ${intent.durationMinutes}-minute ${sport} routine for the user.
Intent: ${JSON.stringify(intent)}
Research notes: ${research.text}
${youtubeNotes ? `Video extraction: ${youtubeNotes}` : ""}
Return concrete, ordered steps with reps and short cues a coach can call out.`,
    RoutineSchema,
  );
  emit({
    stage: "compositor",
    status: "result",
    message: `Drafted: ${routine.title}`,
    data: routine,
  });

  emit({
    stage: "validator",
    status: "start",
    message: "Scientific safety review",
  });
  const validation = await generateJSON(
    `You are a strict movement-safety reviewer. Review this ${sport} routine for safety, biomechanical soundness, and clarity. Tighten vague cues, soften unsafe instructions, cap reps if extreme. Return BOTH the validated routine AND a list of diffs (field path, before, after, reason).
Routine: ${JSON.stringify(routine)}
Pain flags: ${intent.painFlags.join(", ") || "none"}`,
    ValidatorSchema,
  );
  emit({
    stage: "validator",
    status: "result",
    message: `${validation.diffs.length} corrections`,
    data: validation,
  });

  const result: CompileResult = {
    intent,
    routine,
    validated: validation.validated,
    diffs: validation.diffs as ValidatorDiff[],
    youtubeUrl: opts.youtubeUrl,
    sources: research.sources,
  };

  emit({ stage: "done", status: "result", message: "Compiled", data: result });
  return result;
}
