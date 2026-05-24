import { GoogleGenAI } from "@google/genai";
import { z, type ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("[gemini] GEMINI_API_KEY missing — calls will fail.");
}

export const ai = new GoogleGenAI({ apiKey: apiKey ?? "" });

export const MODEL = "gemini-3.5-flash";
export const LIVE_MODEL = "gemini-3.1-flash-live-preview";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export type StepEvent =
  | { kind: "step.start"; stepType: string; index: number }
  | { kind: "step.delta"; deltaType: string; index: number; text?: string }
  | { kind: "step.stop"; stepType: string; index: number; data?: unknown }
  | { kind: "status"; status: string }
  | { kind: "completed"; outputText: string }
  | { kind: "error"; message: string };

export interface RunOptions<S extends ZodType | undefined = undefined> {
  agentName: string;
  system: string;
  input: string;
  thinking?: ThinkingLevel;
  schema?: S;
  tools?: Array<
    | { type: "google_search" }
    | { type: "url_context" }
    | {
        type: "function";
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      }
  >;
  previousInteractionId?: string;
  onEvent?: (e: StepEvent) => void;
  videoUrl?: string;
}

export interface RunResult<T = string> {
  interactionId: string;
  outputText: string;
  parsed?: T;
  sources: string[];
  steps: unknown[];
}

export async function runInteraction<S extends ZodType | undefined = undefined>(
  opts: RunOptions<S>,
): Promise<RunResult<S extends ZodType ? z.infer<S> : never>> {
  const useSchema = opts.schema as ZodType | undefined;
  const responseFormat = useSchema
    ? {
        type: "text" as const,
        mime_type: "application/json" as const,
        schema: zodToJsonSchema(useSchema, {
          target: "openAi",
        }) as Record<string, unknown>,
      }
    : undefined;

  const inputBlocks: Array<Record<string, unknown>> = [];
  if (opts.videoUrl) {
    inputBlocks.push({
      type: "video",
      mime_type: "video/mp4",
      uri: opts.videoUrl,
    });
  }
  inputBlocks.push({ type: "text", text: opts.input });

  const params = {
    model: MODEL,
    input: inputBlocks as never,
    system_instruction: opts.system,
    generation_config: {
      thinking_level: opts.thinking ?? "low",
    },
    tools: opts.tools as never,
    response_format: responseFormat as never,
    previous_interaction_id: opts.previousInteractionId,
    stream: true as const,
  };

  let stream;
  try {
    stream = (await ai.interactions.create(params)) as unknown as AsyncIterable<
      Record<string, unknown>
    >;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onEvent?.({ kind: "error", message: msg });
    throw err;
  }

  let interactionId = "";
  let outputText = "";
  const sources: string[] = [];
  const steps: unknown[] = [];

  for await (const ev of stream) {
    const t = ev.event_type as string | undefined;
    if (t === "interaction.created") {
      const inter = ev.interaction as { id?: string } | undefined;
      if (inter?.id) interactionId = inter.id;
    } else if (t === "step.start") {
      const stepType = (ev.step as { type?: string } | undefined)?.type ?? "";
      const index = ev.index as number;
      opts.onEvent?.({ kind: "step.start", stepType, index });
    } else if (t === "step.delta") {
      const delta = ev.delta as { type?: string; text?: string } | undefined;
      const index = ev.index as number;
      const text = delta?.text;
      if (text && delta?.type === "text") outputText += text;
      opts.onEvent?.({
        kind: "step.delta",
        deltaType: delta?.type ?? "",
        index,
        text,
      });
    } else if (t === "step.stop") {
      const step = ev.step as Record<string, unknown> | undefined;
      const stepType = (step?.type as string | undefined) ?? "";
      const index = ev.index as number;
      steps.push(step);
      if (stepType === "model_output") {
        const content = step?.content as
          | Array<{
              type?: string;
              text?: string;
              annotations?: Array<{
                type?: string;
                url?: string;
                uri?: string;
              }>;
            }>
          | undefined;
        if (content) {
          for (const c of content) {
            if (c.type === "text" && c.text) outputText += c.text;
            for (const a of c.annotations ?? []) {
              const u = a.url ?? a.uri;
              if (u) sources.push(u);
            }
          }
        }
      }
      opts.onEvent?.({ kind: "step.stop", stepType, index, data: step });
    } else if (t === "interaction.completed") {
      const inter = ev.interaction as
        | { id?: string; output_text?: string; status?: string }
        | undefined;
      if (inter?.id) interactionId = inter.id;
      if (inter?.output_text) outputText = inter.output_text;
      opts.onEvent?.({ kind: "completed", outputText });
    } else if (t === "interaction.status_update") {
      const status = (ev.status as string | undefined) ?? "";
      opts.onEvent?.({ kind: "status", status });
    } else if (t === "interaction.error" || t === "error") {
      const message =
        ((ev.error as { message?: string } | undefined)?.message ?? "error") +
        ` (${opts.agentName})`;
      opts.onEvent?.({ kind: "error", message });
    }
  }

  let parsed: unknown;
  if (useSchema && outputText.trim()) {
    try {
      parsed = useSchema.parse(JSON.parse(outputText));
    } catch (err) {
      const msg = `Parse failed in ${opts.agentName}: ${err instanceof Error ? err.message : String(err)}`;
      opts.onEvent?.({ kind: "error", message: msg });
      throw err;
    }
  }

  return {
    interactionId,
    outputText,
    parsed: parsed as S extends ZodType ? z.infer<S> : never,
    sources: dedupe(sources),
    steps,
  };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
