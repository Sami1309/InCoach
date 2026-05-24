# InCoach

An AI visual golf coach. Speak an intent ("fix my slice in 20 min, sore back") and a multi-agent pipeline compiles a researched, safety-validated drill routine with key-moment video chapters.

<img width="1408" height="768" alt="image" src="https://github.com/user-attachments/assets/14e22272-bebf-4c96-bd52-deb63979ae2a" />


## Description

**The compile pipeline.** A request flows through a chain of Gemini Managed Agent interactions: `IntentParser` extracts goal/skill/constraints → `Researcher` grounds in Google Search → `Compositor` drafts a structured routine → `Validator` runs a safety pass that returns explicit `before / after / reason` diffs → a fanout of `VideoScout` sub-agents picks one YouTube demo per drill → `MomentMiner` sub-agents watch each video in parallel and emit 2–4 timestamped key moments. Every stage streams `AgentEvent`s to the client, so the user sees the agents think, the search queries, and the corrections as they happen.

**MomentMiner.** Each drill's video isn't a link — it's a row of clickable timestamps. Gemini's multimodal video understanding extracts second-precise "key moments" (the setup, the strike, the follow-through) with captions and thumbnails. One click seeks the embedded player to that frame.

**Live Coach.** The mic opens a Gemini Live audio session (`ai.live.connect`) with input/output transcription and barge-in. The coach has **tool-calling control of the UI**: `play_step(step_index)` and `show_moment(moment_index)`. Ask "show me the follow-through" and the model calls the tool, the UI jumps to that exact moment, and the coach narrates what's on screen.

**Pose analysis.** Turn on the camera and an in-browser MediaPipe Pose landmarker (GPU delegate) overlays a skeleton on the video and tracks shoulder-midpoint drift against a baseline — a `swayScore` that flags posture breakdowns mid-drill.

**Flow.** Speak intent → watch the agents compile a routine → scrub the mined moments → enable camera + voice → practice with a coach that can drive your screen.

## Stack
- Server: Node 20, Express, `ws`
- Client: React + Vite, MediaPipe Pose
- LLM: Gemini Managed Agents (Interactions API) via `@google/genai`

## Run

```sh
echo "GEMINI_API_KEY=your_key" > .env.local
npm install
npm run dev
```

Open http://localhost:5173.

## Layout
- `server/src/gemini.ts` — Managed Agents wrapper (`runInteraction`)
- `server/src/agents.ts` — pipeline: IntentParser → Researcher → VideoIngest → Compositor → Validator → VideoScout · MomentMiner
- `server/src/live.ts` — live voice session
- `client/src/` — UI, audio capture, pose
- `shared/types.ts` — shared event/result types
