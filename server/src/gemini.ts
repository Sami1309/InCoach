import { GoogleGenAI } from "@google/genai";
import { z, type ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("[gemini] GEMINI_API_KEY missing — calls will fail.");
}

export const ai = new GoogleGenAI({ apiKey: apiKey ?? "" });

export const MODEL = "gemini-3.5-flash";

export async function generateJSON<S extends ZodType>(
  prompt: string,
  schema: S,
): Promise<z.infer<S>> {
  const json = zodToJsonSchema(schema, { target: "openAi" });
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: json,
    },
  });
  return schema.parse(JSON.parse(res.text ?? "{}"));
}

export async function generateGrounded(prompt: string) {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: { tools: [{ googleSearch: {} }] },
  });
  const chunks =
    (res.candidates?.[0]?.groundingMetadata as
      | { groundingChunks?: Array<{ web?: { uri?: string } }> }
      | undefined)?.groundingChunks ?? [];
  const sources = chunks
    .map((c) => c.web?.uri)
    .filter((u): u is string => Boolean(u));
  return { text: res.text ?? "", sources };
}

export async function analyzeYouTube(url: string, prompt: string) {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: url, mimeType: "video/mp4" } },
          { text: prompt },
        ],
      },
    ] as never,
  });
  return res.text ?? "";
}
