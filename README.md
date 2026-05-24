# InCoach - AI Visual golf coach

<img width="1672" height="941" alt="image" src="https://github.com/user-attachments/assets/a7240252-8b77-43d3-a9d5-1bcc055e715d" />



Start with what you want to improve on ("fix my slice in 20 min, sore back") and a multi-agent pipeline compiles a researched, safety-validated drill routine with key-moment video chapters.

## Demo flow

1. **Start with intent.** Hold to talk, or type. The UI streams each agent's reasoning live: Researcher's search queries, Validator's safety diffs, parallel VideoScout / MomentMiner workers labeled `#1`, `#2`, `#3` as they finish.
2. **Routine appears.** Each drill is an embedded player with captioned moment chips. Click a chip → seek to that exact frame.
3. **Open the Live Coach.** Hold to talk. *"Show me the follow-through."* The UI jumps; the coach narrates.
4. **Practice on camera.** A skeleton overlays your video. `swayScore` tracks posture against the drill in real time.

## Description

**The compile pipeline.** A request flows through a chain of Gemini Managed Agent interactions: `IntentParser` extracts goal/skill/constraints → `Researcher` grounds in Google Search → `Compositor` drafts a structured routine → `Validator` runs a safety pass that returns explicit `before / after / reason` diffs → a fanout of `VideoScout` sub-agents picks one YouTube demo per drill → `MomentMiner` sub-agents watch each video in parallel and emit 2–4 timestamped key moments. Every stage streams `AgentEvent`s to the client, so the user sees the agents think, the search queries, and the corrections as they happen.

**MomentMiner.** Each drill's video isn't a link — it's a row of clickable timestamps. Gemini's multimodal video understanding extracts second-precise "key moments" (the setup, the strike, the follow-through) with captions and thumbnails. One click seeks the embedded player to that frame.

**Live Coach.** The mic opens a Gemini Live audio session (`ai.live.connect`) with input/output transcription and barge-in. The coach has **tool-calling control of the UI**: `play_step(step_index)` and `show_moment(moment_index)`. Ask "show me the follow-through" and the model calls the tool, the UI jumps to that exact moment, and the coach narrates what's on screen.

**Pose analysis.** Turn on the camera and an in-browser MediaPipe Pose landmarker (GPU delegate) overlays a skeleton on the video and tracks shoulder-midpoint drift against a baseline — a `swayScore` that flags posture breakdowns mid-drill.

**Flow.** Speak intent → watch the agents compile a routine → scrub the mined moments → enable camera + voice → practice with a coach that can drive your screen.

## How the Managed Agents compose

The pipeline uses Gemini's **Managed Agents** (the Interactions API), not raw `generateContent`. Each sub-agent is a single `ai.interactions.create(...)` call with its own `system_instruction`, `thinking_level`, an optional Zod-derived JSON `response_format`, and a toolset drawn from `google_search`, `url_context`, declared functions, or a multimodal video input. Gemini executes the interaction server-side and streams a typed step taxonomy (`thought`, `model_output`, `google_search_call`, `url_context_call`, `function_call`, …) wrapped in lifecycle events. We never round-trip search or URL fetches through our code — the managed agent runs them itself; we only observe.

`runInteraction()` in `server/src/gemini.ts` accumulates output text, collects citation annotations into `sources[]`, enforces structured output by re-parsing with Zod, and exposes an `onEvent` callback. `server/src/agents.ts` wires that callback through a `bridge()` function that maps each step into a labeled `AgentEvent` (`"google search: <query>"`, `"thinking…"`, `"calling tool"`, …) and forwards it over WebSocket so the client renders every move the agent makes.

`runPipeline()` composes seven of those interactions into a directed graph: `IntentParser` → `Researcher` (google_search) → optional `VideoIngest` (video URL) → `Compositor` → `Validator` (returns routine + diff array) → `Promise.all` fanout of `VideoScout` sub-agents → `Promise.all` fanout of `MomentMiner` sub-agents. The pipeline shape and parallelism are plain JS; per-step reasoning, search grounding, video understanding, citation tracking, and JSON-conformant output are all the Managed Agent's job — which is what lets each agent be defined in ~10 lines of config instead of a hand-built tool loop.

## The Live Coach (Gemini Live API)

A second managed surface — `ai.live.connect` — opens a bidirectional audio session with input/output transcription and barge-in. It's declared with two function tools, `play_step(step_index)` and `show_moment(moment_index)`. The model decides when to call them; when it does, the server forwards the call to the client, the UI navigates accordingly, and the coach narrates the result. This makes voice a control plane, not a chat surface.

## Stack
- Server: Node 20, Express, `ws`
- Client: React + Vite, MediaPipe Pose (`@mediapipe/tasks-vision`)
- LLM: Gemini **Managed Agents** (Interactions API) + **Live API** via `@google/genai`
- Validation: Zod schemas → JSON Schema via `zod-to-json-schema`

## Managed Agent Architecture

<img width="1408" height="768" alt="image" src="https://github.com/user-attachments/assets/14e22272-bebf-4c96-bd52-deb63979ae2a" />


## Run

```sh
echo "GEMINI_API_KEY=your_key" > .env.local
npm install
npm run dev
```

Open http://localhost:5173.

## Screenshot

<img width="1401" height="748" alt="image" src="https://github.com/user-attachments/assets/dbf3522d-d744-4401-a31a-5d7ad82ed6f8" />


## Layout
- `server/src/gemini.ts` — Managed Agents wrapper (`runInteraction`), event stream consumer, Zod re-parse
- `server/src/agents.ts` — pipeline graph: IntentParser → Researcher → VideoIngest → Compositor → Validator → VideoScout · MomentMiner
- `server/src/live.ts` — Gemini Live voice session with `play_step` / `show_moment` tool calls
- `client/src/pose.ts` — MediaPipe Pose loop + sway scoring
- `client/src/live.ts` — client-side live audio bridge, PCM playback, barge-in
- `client/src/App.tsx` — agent stream UI, drill cards with moment chips, voice + camera panels
- `shared/types.ts` — `AgentEvent`, `Routine`, `DrillVideo`, `DrillMoment`, `ValidatorDiff`
