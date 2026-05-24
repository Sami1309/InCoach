import { z } from "zod";
import {
  generateJSON,
  generateGrounded,
  analyzeYouTube,
  analyzeYouTubeJSON,
  MODEL,
} from "./gemini.js";
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

const VIDEO_ID_RE = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/;
function extractVideoId(url: string): string | null {
  const m = url.match(VIDEO_ID_RE);
  return m ? m[1] : null;
}

export async function runPipeline(
  transcript: string,
  emit: Emit,
  opts: { youtubeUrl?: string; sport?: string } = {},
): Promise<CompileResult> {
  const sport = opts.sport ?? "golf";

  const intentPrompt = `Parse this ${sport} coaching request into a movement intent. Request: "${transcript}". Default activity to ${sport} if unspecified.`;
  emit({
    stage: "intent",
    agent: "IntentParser",
    model: MODEL,
    query: intentPrompt,
    status: "start",
    message: "Parsing intent",
  });
  const intent: Intent = await generateJSON(intentPrompt, IntentSchema);
  emit({
    stage: "intent",
    agent: "IntentParser",
    status: "result",
    message: `Goal: ${intent.goal}`,
    data: intent,
  });

  const researchPrompt = `Find 2 to 3 safe, high quality ${sport} drills that target: ${intent.goal}. Skill: ${intent.skillLevel}. Equipment: ${intent.equipment.join(", ") || "none"}. Constraints: ${intent.constraints.join(", ") || "none"}. Provide concrete cues.`;
  emit({
    stage: "researcher",
    agent: "Researcher",
    model: MODEL,
    query: researchPrompt,
    status: "start",
    message: "Searching drills with Google grounding",
  });
  const research = await generateGrounded(researchPrompt);
  emit({
    stage: "researcher",
    agent: "Researcher",
    status: "result",
    message: `Found ${research.sources.length} sources`,
    data: { sources: research.sources, snippet: research.text.slice(0, 280) },
  });

  let youtubeNotes = "";
  if (opts.youtubeUrl) {
    const ytPrompt = `Extract setup steps, key verbal cues, and corrective adaptations from this ${sport} video. Return as a short structured list.`;
    emit({
      stage: "youtube",
      agent: "VideoIngest",
      model: MODEL,
      query: `${opts.youtubeUrl} :: ${ytPrompt}`,
      status: "start",
      message: `Ingesting reference video`,
    });
    youtubeNotes = await analyzeYouTube(opts.youtubeUrl, ytPrompt);
    emit({
      stage: "youtube",
      agent: "VideoIngest",
      status: "result",
      message: "Extracted drill cues from video",
      data: { notes: youtubeNotes.slice(0, 320), url: opts.youtubeUrl },
    });
  }

  const composePrompt = `Compose a ${intent.durationMinutes}-minute ${sport} routine for the user.
Intent: ${JSON.stringify(intent)}
Research notes: ${research.text}
${youtubeNotes ? `Video extraction: ${youtubeNotes}` : ""}
Return concrete, ordered steps with reps and short cues a coach can call out.`;
  emit({
    stage: "compositor",
    agent: "Compositor",
    model: MODEL,
    query: composePrompt.slice(0, 600),
    status: "start",
    message: "Compiling routine",
  });
  const routine: Routine = await generateJSON(composePrompt, RoutineSchema);
  emit({
    stage: "compositor",
    agent: "Compositor",
    status: "result",
    message: `Drafted: ${routine.title}`,
    data: routine,
  });

  const validatePrompt = `You are a strict movement-safety reviewer. Review this ${sport} routine for safety, biomechanical soundness, and clarity. Tighten vague cues, soften unsafe instructions, cap reps if extreme. Return BOTH the validated routine AND a list of diffs (field path, before, after, reason).
Routine: ${JSON.stringify(routine)}
Pain flags: ${intent.painFlags.join(", ") || "none"}`;
  emit({
    stage: "validator",
    agent: "Validator",
    model: MODEL,
    query: validatePrompt.slice(0, 600),
    status: "start",
    message: "Scientific safety review",
  });
  const validation = await generateJSON(validatePrompt, ValidatorSchema);
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
    message: "Finding YouTube demos per drill",
  });
  const videos: DrillVideo[] = [];
  await Promise.all(
    validation.validated.steps.map(async (step, idx) => {
      const q = `site:youtube.com best ${sport} tutorial that demonstrates: "${step.title}". Cue: ${step.cue}. Goal: ${intent.goal}. Return the full youtube.com/watch?v=... URL in your answer.`;
      emit({
        stage: "videos",
        agent: `VideoScout #${idx + 1}`,
        model: MODEL,
        query: q,
        status: "thinking",
        message: `Step ${idx + 1}: searching "${step.title}"`,
      });
      try {
        const r = await generateGrounded(q);
        const all = [...r.sources, ...extractUrlsFromText(r.text)];
        const yt = all.find((u) => extractVideoId(u));
        if (yt) {
          const id = extractVideoId(yt)!;
          const v: DrillVideo = {
            stepIndex: idx,
            query: q,
            videoId: id,
            url: `https://www.youtube.com/watch?v=${id}`,
            thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          };
          videos.push(v);
          emit({
            stage: "videos",
            agent: `VideoScout #${idx + 1}`,
            status: "result",
            message: `Picked video for step ${idx + 1}`,
            data: v,
          });
        } else {
          emit({
            stage: "videos",
            agent: `VideoScout #${idx + 1}`,
            status: "result",
            message: `No video found for step ${idx + 1}`,
          });
        }
      } catch (err) {
        emit({
          stage: "videos",
          agent: `VideoScout #${idx + 1}`,
          status: "error",
          message: `Video search failed: ${err instanceof Error ? err.message : String(err)}`,
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
  await Promise.all(
    videos.map(async (v) => {
      const step = validation.validated.steps[v.stepIndex];
      const q = `Watch this ${sport} drill video and pick 2-4 key moments that visually demonstrate the cue "${step?.cue ?? ""}" for the drill "${step?.title ?? ""}". For each moment return a timestamp in seconds (integer) and a one-line caption describing what the user should see. Avoid intro/outro/talking-head segments. Return JSON.`;
      emit({
        stage: "videos",
        agent: `MomentMiner #${v.stepIndex + 1}`,
        model: MODEL,
        query: q,
        status: "thinking",
        message: `Mining key moments from step ${v.stepIndex + 1} video`,
      });
      try {
        const parsed = await analyzeYouTubeJSON(v.url, q, MomentsSchema);
        v.moments = parsed.moments.map((m, mi): DrillMoment => ({
          t: Math.max(0, Math.floor(m.t)),
          caption: m.caption,
          thumb: `https://i.ytimg.com/vi/${v.videoId}/${(mi % 3) + 1}.jpg`,
        }));
        v.start = v.moments[0]?.t;
        emit({
          stage: "videos",
          agent: `MomentMiner #${v.stepIndex + 1}`,
          status: "result",
          message: `${v.moments.length} moments for step ${v.stepIndex + 1}`,
          data: v.moments,
        });
      } catch (err) {
        emit({
          stage: "videos",
          agent: `MomentMiner #${v.stepIndex + 1}`,
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
    sources: research.sources,
  };

  emit({ stage: "done", status: "result", message: "Compiled", data: result });
  return result;
}

function extractUrlsFromText(text: string): string[] {
  const re = /https?:\/\/[^\s)\]"']+/g;
  return text.match(re) ?? [];
}
