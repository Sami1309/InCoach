import { z } from "zod";
import { runInteraction, MODEL, type StepEvent } from "./gemini.js";
import type {
  AgentEvent,
  CompileResult,
  DrillMoment,
  DrillVideo,
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

const VideoPickSchema = z.object({
  url: z.string(),
  reason: z.string().optional(),
});

const MomentsSchema = z.object({
  moments: z
    .array(
      z.object({
        t: z.number().describe("timestamp in seconds"),
        caption: z.string(),
      }),
    )
    .min(1)
    .max(4),
});

const VIDEO_ID_RE = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/;
const extractVideoId = (u: string) => u.match(VIDEO_ID_RE)?.[1] ?? null;

function bridge(
  emit: Emit,
  stage: AgentEvent["stage"],
  agentName: string,
): (e: StepEvent) => void {
  return (e) => {
    if (e.kind === "step.start") {
      const label = stepLabel(e.stepType);
      if (label)
        emit({
          stage,
          agent: agentName,
          model: MODEL,
          status: "thinking",
          message: label,
        });
    } else if (e.kind === "step.stop") {
      if (e.stepType === "google_search_call") {
        const args = (e.data as { arguments?: { queries?: string[] } })
          ?.arguments;
        const q = args?.queries?.join(", ") ?? "";
        emit({
          stage,
          agent: agentName,
          status: "thinking",
          message: `google search: ${q}`,
          query: q,
        });
      }
    } else if (e.kind === "status") {
      emit({
        stage,
        agent: agentName,
        status: "thinking",
        message: `status: ${e.status}`,
      });
    } else if (e.kind === "error") {
      emit({
        stage,
        agent: agentName,
        status: "error",
        message: e.message,
      });
    }
  };
}

function stepLabel(t: string): string | null {
  switch (t) {
    case "thought":
      return "thinking…";
    case "model_output":
      return "writing answer";
    case "google_search_call":
      return "calling google search";
    case "google_search_result":
      return "received search results";
    case "url_context_call":
      return "fetching URL";
    case "url_context_result":
      return "URL contents loaded";
    case "function_call":
      return "calling tool";
    case "function_result":
      return "tool returned";
    default:
      return null;
  }
}

export async function runPipeline(
  transcript: string,
  emit: Emit,
  opts: { youtubeUrl?: string; sport?: string } = {},
): Promise<CompileResult> {
  const sport = opts.sport ?? "golf";

  emit({
    stage: "intent",
    agent: "IntentParser",
    model: MODEL,
    status: "start",
    message: "Parsing intent",
    query: transcript,
  });
  const intentRun = await runInteraction({
    agentName: "IntentParser",
    system: `You are the IntentParser sub-agent in a multi-agent ${sport} coaching pipeline. Extract a structured movement intent from the user's request. Default activity to ${sport} if unspecified. Be conservative on durationMinutes (cap at 60).`,
    input: `Parse this request: "${transcript}"`,
    thinking: "low",
    schema: IntentSchema,
    onEvent: bridge(emit, "intent", "IntentParser"),
  });
  const intent: Intent = intentRun.parsed!;
  emit({
    stage: "intent",
    agent: "IntentParser",
    status: "result",
    message: `Goal: ${intent.goal}`,
    data: intent,
  });

  emit({
    stage: "researcher",
    agent: "Researcher",
    model: MODEL,
    status: "start",
    message: "Searching drills with Google grounding",
    query: intent.goal,
  });
  const researchRun = await runInteraction({
    agentName: "Researcher",
    system: `You are the Researcher sub-agent. Use Google search to find 2-3 safe, biomechanically sound ${sport} drills targeting the user's goal. Cite sources by URL. Output a concise paragraph the Compositor can use.`,
    input: `Goal: ${intent.goal}. Skill: ${intent.skillLevel}. Equipment: ${intent.equipment.join(", ") || "none"}. Constraints: ${intent.constraints.join(", ") || "none"}. Find specific, named drills with cues.`,
    thinking: "medium",
    tools: [{ type: "google_search" }],
    onEvent: bridge(emit, "researcher", "Researcher"),
  });
  emit({
    stage: "researcher",
    agent: "Researcher",
    status: "result",
    message: `Found ${researchRun.sources.length} sources`,
    data: {
      sources: researchRun.sources,
      snippet: researchRun.outputText.slice(0, 280),
    },
  });

  let youtubeNotes = "";
  if (opts.youtubeUrl) {
    emit({
      stage: "youtube",
      agent: "VideoIngest",
      model: MODEL,
      status: "start",
      message: "Ingesting reference video",
      query: opts.youtubeUrl,
    });
    const ytRun = await runInteraction({
      agentName: "VideoIngest",
      system: `You are the VideoIngest sub-agent. Extract structured drill insights from the user's reference YouTube video.`,
      input: `Watch this ${sport} video and extract setup steps, key verbal cues, and corrective adaptations.`,
      thinking: "medium",
      videoUrl: opts.youtubeUrl,
      onEvent: bridge(emit, "youtube", "VideoIngest"),
    });
    youtubeNotes = ytRun.outputText;
    emit({
      stage: "youtube",
      agent: "VideoIngest",
      status: "result",
      message: "Extracted drill cues from video",
      data: { notes: youtubeNotes.slice(0, 320), url: opts.youtubeUrl },
    });
  }

  emit({
    stage: "compositor",
    agent: "Compositor",
    model: MODEL,
    status: "start",
    message: "Compiling routine",
  });
  const composeRun = await runInteraction({
    agentName: "Compositor",
    system: `You are the Compositor sub-agent. Compose an ordered, demonstrable ${sport} routine from intent + research. Short coach-callable cues. Reps/duration realistic. Return JSON matching the schema.`,
    input: `Intent: ${JSON.stringify(intent)}\nResearch: ${researchRun.outputText}\n${youtubeNotes ? `Video notes: ${youtubeNotes}` : ""}\nCompose a ${intent.durationMinutes}-minute routine.`,
    thinking: "medium",
    schema: RoutineSchema,
    onEvent: bridge(emit, "compositor", "Compositor"),
  });
  const routine: Routine = composeRun.parsed!;
  emit({
    stage: "compositor",
    agent: "Compositor",
    status: "result",
    message: `Drafted: ${routine.title}`,
    data: routine,
  });

  emit({
    stage: "validator",
    agent: "Validator",
    model: MODEL,
    status: "start",
    message: "Scientific safety review",
  });
  const validateRun = await runInteraction({
    agentName: "Validator",
    system: `You are the Validator sub-agent — a strict ${sport} movement-safety reviewer. Tighten vague cues, soften unsafe instructions, cap extreme reps. Return both the validated routine and a list of diffs (field, before, after, reason).`,
    input: `Routine: ${JSON.stringify(routine)}\nPain flags: ${intent.painFlags.join(", ") || "none"}`,
    thinking: "high",
    schema: ValidatorSchema,
    onEvent: bridge(emit, "validator", "Validator"),
  });
  const validation = validateRun.parsed!;
  emit({
    stage: "validator",
    agent: "Validator",
    status: "result",
    message: `${validation.diffs.length} corrections`,
    data: validation,
  });

  emit({
    stage: "videos",
    agent: "VideoScout",
    model: MODEL,
    status: "start",
    message: "Finding YouTube demos per drill (parallel sub-agents)",
  });
  const videos: DrillVideo[] = [];
  await Promise.all(
    validation.validated.steps.map(async (step, idx) => {
      const agentName = `VideoScout #${idx + 1}`;
      emit({
        stage: "videos",
        agent: agentName,
        model: MODEL,
        status: "thinking",
        message: `Searching: "${step.title}"`,
        query: step.title,
      });
      try {
        const pick = await runInteraction({
          agentName,
          system: `You are a VideoScout sub-agent. Find ONE high-quality YouTube tutorial that visually demonstrates the given ${sport} drill. Use google search restricted to youtube.com. Return strict JSON {url, reason}.`,
          input: `Drill: "${step.title}". Cue: ${step.cue}. Find best youtube.com/watch?v=... URL.`,
          thinking: "low",
          tools: [{ type: "google_search" }],
          schema: VideoPickSchema,
          onEvent: bridge(emit, "videos", agentName),
        });
        if (!pick.parsed) {
          emit({
            stage: "videos",
            agent: agentName,
            status: "error",
            message: `No usable result for step ${idx + 1}`,
          });
          return;
        }
        const id = extractVideoId(pick.parsed.url);
        if (id) {
          const v: DrillVideo = {
            stepIndex: idx,
            query: step.title,
            videoId: id,
            url: `https://www.youtube.com/watch?v=${id}`,
            thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          };
          videos.push(v);
          emit({
            stage: "videos",
            agent: agentName,
            status: "result",
            message: `Picked video for step ${idx + 1}`,
            data: v,
          });
        } else {
          emit({
            stage: "videos",
            agent: agentName,
            status: "error",
            message: `No valid YouTube URL for step ${idx + 1}`,
          });
        }
      } catch (err) {
        emit({
          stage: "videos",
          agent: agentName,
          status: "error",
          message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),
  );
  videos.sort((a, b) => a.stepIndex - b.stepIndex);
  emit({
    stage: "videos",
    agent: "VideoScout",
    status: "result",
    message: `${videos.length}/${validation.validated.steps.length} videos`,
    data: videos,
  });

  await Promise.all(
    videos.map(async (v) => {
      const step = validation.validated.steps[v.stepIndex];
      const agentName = `MomentMiner #${v.stepIndex + 1}`;
      emit({
        stage: "videos",
        agent: agentName,
        model: MODEL,
        status: "thinking",
        message: `Mining key moments from step ${v.stepIndex + 1}`,
        query: step?.title,
      });
      try {
        const r = await runInteraction({
          agentName,
          system: `You are the MomentMiner sub-agent. Watch a ${sport} drill video and pick 2-4 visually distinct key moments matching the drill cue. Each moment has a second-precise timestamp and a one-line caption. Skip talking-head and intro/outro frames.`,
          input: `Drill: "${step?.title ?? ""}". Cue: ${step?.cue ?? ""}. Pick moments.`,
          thinking: "medium",
          videoUrl: v.url,
          schema: MomentsSchema,
          onEvent: bridge(emit, "videos", agentName),
        });
        v.moments = r.parsed!.moments.map(
          (m, mi): DrillMoment => ({
            t: Math.max(0, Math.floor(m.t)),
            caption: m.caption,
            thumb: `https://i.ytimg.com/vi/${v.videoId}/${(mi % 3) + 1}.jpg`,
          }),
        );
        v.start = v.moments[0]?.t;
        emit({
          stage: "videos",
          agent: agentName,
          status: "result",
          message: `${v.moments.length} moments for step ${v.stepIndex + 1}`,
          data: v.moments,
        });
      } catch (err) {
        emit({
          stage: "videos",
          agent: agentName,
          status: "error",
          message: `Moment mining failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),
  );

  const result: CompileResult = {
    intent,
    routine,
    validated: validation.validated,
    diffs: validation.diffs as ValidatorDiff[],
    videos,
    youtubeUrl: opts.youtubeUrl,
    sources: researchRun.sources,
  };

  emit({ stage: "done", status: "result", message: "Compiled", data: result });
  return result;
}
