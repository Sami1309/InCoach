# InCoach

A coach compiler. Speak an intent ("fix my slice in 20 min, sore back") and a multi-agent pipeline compiles a researched, safety-validated drill routine with key-moment video chapters.

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
