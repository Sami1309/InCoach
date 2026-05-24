import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, CompileResult, DrillVideo } from "@shared/types";
import { initPose, startPoseLoop, type PoseTick } from "./pose";
import { startMicCapture, type MicCapture } from "./audio";
import { LiveSession } from "./live";

const MEMORY_KEY = "coach-compiler.session";

interface Memory {
  transcript: string;
  youtubeUrl?: string;
  sport: string;
  result?: CompileResult;
  savedAt: number;
}

type Message = { role: "user" | "model"; text: string; closed: boolean };

export function App() {
  const [transcript, setTranscript] = useState(
    "I'm hitting a lot of fat shots with my 7-iron. Indoor mat at home, 15 minutes.",
  );
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [sport, setSport] = useState("golf");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [recalled, setRecalled] = useState<Memory | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [momentIdx, setMomentIdx] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const [agentOpen, setAgentOpen] = useState(true);
  const [diffOpen, setDiffOpen] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [poseOn, setPoseOn] = useState(false);
  const [sway, setSway] = useState<number | null>(null);
  const swayRef = useRef<number | null>(null);
  const stopPoseRef = useRef<(() => void) | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [liveOn, setLiveOn] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [voiceState, setVoiceState] = useState<
    "idle" | "listening" | "thinking" | "speaking"
  >("idle");
  const [micLevel, setMicLevel] = useState(0);
  const liveRef = useRef<LiveSession | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const lastSwayPushRef = useRef(0);
  const userSpeakingRef = useRef(false);
  const userQuietSinceRef = useRef<number | null>(null);

  const agentScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (raw) {
      try {
        setRecalled(JSON.parse(raw) as Memory);
      } catch {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    if (!agentOpen) return;
    const el = agentScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, agentOpen]);

  const compile = async () => {
    setEvents([]);
    setResult(null);
    setStepIdx(0);
    setMomentIdx(0);
    setAutoplay(false);
    setCompiling(true);
    setAgentOpen(true);
    const params = new URLSearchParams({ transcript, sport });
    if (youtubeUrl.trim()) params.set("youtubeUrl", youtubeUrl.trim());
    const es = new EventSource(`/api/compile?${params.toString()}`);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as AgentEvent;
        setEvents((prev) => [...prev, ev]);
        if (ev.stage === "done" && ev.data) {
          const r = ev.data as CompileResult;
          setResult(r);
          const mem: Memory = {
            transcript,
            youtubeUrl: youtubeUrl || undefined,
            sport,
            result: r,
            savedAt: Date.now(),
          };
          localStorage.setItem(MEMORY_KEY, JSON.stringify(mem));
          setRecalled(mem);
          setAgentOpen(false);
        }
        if (ev.stage === "done" || ev.stage === "error") {
          es.close();
          setCompiling(false);
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      es.close();
      setCompiling(false);
    };
  };

  const togglePose = async () => {
    if (poseOn) {
      stopPoseRef.current?.();
      stopPoseRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setPoseOn(false);
      setSway(null);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 960, height: 600, facingMode: "user" },
    });
    streamRef.current = stream;
    const video = videoRef.current!;
    video.srcObject = stream;
    await video.play();
    await initPose();
    stopPoseRef.current = startPoseLoop(
      video,
      canvasRef.current!,
      (tick: PoseTick) => {
        swayRef.current = tick.swayScore;
        setSway(tick.swayScore);
      },
    );
    setPoseOn(true);
  };

  const buildSystem = (r: CompileResult | null) => {
    const base = `You are an encouraging ${sport} coach for the user's session: "${transcript}". Keep cues short — one breath, one or two short sentences. If the user mentions pain, pause and recommend a safety screen. The user can interrupt you any time.`;
    if (!r) return base;
    const lines = r.validated.steps
      .map(
        (s, i) =>
          `${i}: ${s.title} — ${s.cue} (${s.reps}x, ${s.durationSec}s)`,
      )
      .join("\n");
    return `${base}\nRoutine: ${r.validated.title}.\nSteps (0-indexed):\n${lines}\nWhen the user asks to start, replay, advance, go back, or to show a specific phase, CALL the matching tool: play_step(step_index) or show_moment(moment_index). Don't describe the call — just call it and then briefly narrate.`;
  };

  const handleToolCall = (
    id: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    let ok = false;
    if (name === "play_step" && typeof args.step_index === "number" && result) {
      const i = Math.max(
        0,
        Math.min(result.validated.steps.length - 1, args.step_index),
      );
      setStepIdx(i);
      setMomentIdx(0);
      setAutoplay(true);
      ok = true;
    } else if (
      name === "show_moment" &&
      typeof args.moment_index === "number" &&
      result
    ) {
      const v = result.videos.find((x) => x.stepIndex === stepIdx);
      const max = (v?.moments?.length ?? 1) - 1;
      const m = Math.max(0, Math.min(Math.max(max, 0), args.moment_index));
      setMomentIdx(m);
      setAutoplay(true);
      ok = true;
    }
    liveRef.current?.sendToolResponse(id, {
      status: ok ? "ok" : "unknown_tool_or_args",
    });
  };

  const startLive = async (r: CompileResult | null) => {
    if (liveRef.current) return;
    setMessages([]);
    setVoiceState("idle");
    const session = new LiveSession({
      systemInstruction: buildSystem(r),
      onEvent: (e) => {
        if (e.kind === "transcript") {
          appendMessage(setMessages, e.role, e.text);
          if (e.role === "model") setVoiceState("speaking");
        } else if (e.kind === "modelAudio") {
          setVoiceState("speaking");
        } else if (e.kind === "turnEnd") {
          closeOpenMessage(setMessages);
          setVoiceState("idle");
        } else if (e.kind === "interrupted") {
          closeOpenMessage(setMessages);
          setVoiceState("listening");
        } else if (e.kind === "toolCall") {
          handleToolCall(e.id, e.name, e.args as Record<string, unknown>);
        } else if (e.kind === "open") {
          session.sendText(
            r
              ? `Greet me in one short sentence and announce we are on step 0: ${r.validated.steps[0]?.title}.`
              : "Greet me briefly and ask what we are working on today.",
          );
          setVoiceState("thinking");
        }
      },
    });
    session.connect();
    liveRef.current = session;
    try {
      micRef.current = await startMicCapture({
        onChunk: (pcm) => session.sendAudio(pcm),
        onLevel: (lvl) => {
          setMicLevel(lvl);
          const speaking = lvl > 0.02;
          if (speaking) {
            if (!userSpeakingRef.current) {
              userSpeakingRef.current = true;
              setVoiceState("listening");
            }
            userQuietSinceRef.current = null;
          } else if (userSpeakingRef.current) {
            if (userQuietSinceRef.current == null)
              userQuietSinceRef.current = Date.now();
            else if (Date.now() - userQuietSinceRef.current > 350) {
              userSpeakingRef.current = false;
              userQuietSinceRef.current = null;
              setVoiceState((cur) => (cur === "listening" ? "thinking" : cur));
            }
          }
        },
      });
    } catch {
      /* mic denied */
    }
    setLiveOn(true);
  };

  const stopLive = () => {
    micRef.current?.stop();
    micRef.current = null;
    liveRef.current?.close();
    liveRef.current = null;
    setLiveOn(false);
    setVoiceState("idle");
    setMicLevel(0);
    userSpeakingRef.current = false;
    userQuietSinceRef.current = null;
  };

  const toggleLive = async () => {
    if (liveOn) stopLive();
    else await startLive(result);
  };

  useEffect(() => {
    if (!result || !liveRef.current) return;
    const step = result.validated.steps[stepIdx];
    if (!step) return;
    liveRef.current.sendText(
      `[STATE] step_index=${stepIdx} of ${result.validated.steps.length}. Title: ${step.title}. Cue: ${step.cue}.`,
    );
  }, [stepIdx, result]);

  useEffect(() => {
    if (!liveOn || !poseOn) return;
    const id = window.setInterval(() => {
      const s = swayRef.current;
      if (s == null || !liveRef.current) return;
      const now = Date.now();
      if (now - lastSwayPushRef.current < 2500) return;
      lastSwayPushRef.current = now;
      if (Math.abs(s) >= 2) {
        liveRef.current.sendText(
          `[POSE] sway Δ ${s.toFixed(1)} ${s > 0 ? "right" : "left"}.`,
        );
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [liveOn, poseOn]);

  const recall = () => {
    if (!recalled) return;
    setTranscript(recalled.transcript);
    setYoutubeUrl(recalled.youtubeUrl ?? "");
    setSport(recalled.sport);
    if (recalled.result) {
      setResult(recalled.result);
      setStepIdx(0);
      setMomentIdx(0);
      setAgentOpen(false);
    }
  };

  const platformLine = useMemo(() => {
    if (!result) return null;
    const intent = result.intent;
    return `${cap(intent.activity)} coach — voice-first. Compiles ${intent.durationMinutes}-min routines from one sentence and coaches you through them live.`;
  }, [result]);

  const steps = result?.validated.steps ?? [];
  const currentStep = steps[stepIdx];
  const videoForStep = (i: number): DrillVideo | undefined =>
    result?.videos.find((v) => v.stepIndex === i);
  const currentVideo = videoForStep(stepIdx);
  const currentMoment = currentVideo?.moments?.[momentIdx];
  const currentT =
    currentMoment?.t ?? currentVideo?.start ?? currentVideo?.moments?.[0]?.t;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          Coach Compiler
          <span className="sub mono">gemini-3.5-flash · managed agents</span>
        </div>
        <div className="row">
          {recalled && !liveOn && (
            <button onClick={recall} title={`Saved ${timeAgo(recalled.savedAt)}`}>
              Recall last
            </button>
          )}
          <button onClick={togglePose}>
            {poseOn ? "Camera off" : "Camera"}
          </button>
          <button
            className={liveOn ? "" : "primary"}
            onClick={toggleLive}
          >
            {liveOn ? "End coach" : "Talk to coach"}
          </button>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar">
          <section className="card">
            <div className="card-header">
              <span className="card-title">Brief</span>
            </div>
            <div className="card-body controls">
              <input
                type="text"
                value={sport}
                onChange={(e) => setSport(e.target.value)}
                placeholder="sport"
              />
              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder="What do you want to work on?"
              />
              <input
                type="text"
                value={youtubeUrl}
                placeholder="YouTube reference (optional)"
                onChange={(e) => setYoutubeUrl(e.target.value)}
              />
              <button
                className="primary block"
                onClick={compile}
                disabled={compiling || !transcript.trim()}
              >
                {compiling ? "Compiling…" : "Compile routine"}
              </button>
            </div>
          </section>

          <section className="card flex-1">
            <div className="card-header">
              <span className="card-title">
                {result ? "Routine" : compiling ? "Building" : "—"}
              </span>
              {result && result.diffs.length > 0 && (
                <button
                  className="chip"
                  onClick={() => setDiffOpen((v) => !v)}
                  title="Validator corrections"
                >
                  {result.diffs.length} validated
                </button>
              )}
            </div>
            <div className="card-body">
              {result ? (
                <RoutineOutline
                  result={result}
                  stepIdx={stepIdx}
                  onSelect={(i) => {
                    setStepIdx(i);
                    setMomentIdx(0);
                    setAutoplay(true);
                  }}
                  diffOpen={diffOpen}
                />
              ) : compiling ? (
                <ProgressCard events={events} />
              ) : (
                <div className="empty">
                  Tell me what you want to work on, then hit Compile.
                </div>
              )}
              {platformLine && result && (
                <div className="footer-line">{platformLine}</div>
              )}
            </div>
          </section>
        </aside>

        <section className="hero">
          <div className="hero-grid">
            <div className="coach">
              <video ref={videoRef} muted playsInline />
              <canvas ref={canvasRef} />
              {!poseOn && (
                <div className="overlay">
                  <span className="mono" style={{ opacity: 0.55 }}>
                    Camera off
                  </span>
                </div>
              )}
              {sway != null && (
                <div className="sway-badge">
                  <span className="mono">sway Δ {sway.toFixed(1)}</span>
                </div>
              )}
            </div>

            <div className="hero-right">
              <VoiceBar
                state={voiceState}
                level={micLevel}
                liveOn={liveOn}
              />
              {result && currentStep ? (
                <DrillRunner
                  total={steps.length}
                  index={stepIdx}
                  step={currentStep}
                  video={currentVideo}
                  moments={currentVideo?.moments ?? []}
                  momentIdx={momentIdx}
                  startT={currentT}
                  autoplay={autoplay}
                  onPrev={() => {
                    setStepIdx((i) => Math.max(0, i - 1));
                    setMomentIdx(0);
                    setAutoplay(true);
                  }}
                  onNext={() => {
                    setStepIdx((i) => Math.min(steps.length - 1, i + 1));
                    setMomentIdx(0);
                    setAutoplay(true);
                  }}
                  onSelectMoment={(i) => {
                    setMomentIdx(i);
                    setAutoplay(true);
                  }}
                />
              ) : (
                <div className="hero-placeholder">
                  {compiling ? (
                    <ProgressCard events={events} large />
                  ) : (
                    <div className="empty">
                      Your drill will appear here. Hit Compile to start.
                    </div>
                  )}
                </div>
              )}
              <LiveMessages messages={messages} />
            </div>
          </div>
        </section>
      </div>

      <AgentDrawer
        open={agentOpen}
        onToggle={() => setAgentOpen((v) => !v)}
        events={events}
        scrollRef={agentScrollRef}
        compiling={compiling}
      />
    </div>
  );
}

function appendMessage(
  set: React.Dispatch<React.SetStateAction<Message[]>>,
  role: "user" | "model",
  text: string,
) {
  set((prev) => {
    const last = prev[prev.length - 1];
    if (last && last.role === role && !last.closed) {
      const sep =
        last.text && /[\w]$/.test(last.text) && /^[\w]/.test(text) ? " " : "";
      const next = prev.slice(0, -1);
      next.push({ role, text: last.text + sep + text, closed: false });
      return next;
    }
    const updated = last && !last.closed ? [...prev.slice(0, -1), { ...last, closed: true }] : prev;
    return [...updated.slice(-16), { role, text, closed: false }];
  });
}

function closeOpenMessage(
  set: React.Dispatch<React.SetStateAction<Message[]>>,
) {
  set((prev) => {
    const last = prev[prev.length - 1];
    if (!last || last.closed) return prev;
    return [...prev.slice(0, -1), { ...last, closed: true }];
  });
}

function VoiceBar({
  state,
  level,
  liveOn,
}: {
  state: "idle" | "listening" | "thinking" | "speaking";
  level: number;
  liveOn: boolean;
}) {
  const label = !liveOn
    ? "Tap “Talk to coach” to start"
    : state === "listening"
      ? "Listening…"
      : state === "thinking"
        ? "Coach thinking…"
        : state === "speaking"
          ? "Coach speaking"
          : "Listening for you";
  const pct = Math.min(100, Math.round(level * 100 * 6));
  return (
    <div className={`voicebar voice-${liveOn ? state : "off"}`}>
      <div className="row" style={{ gap: 10, alignItems: "center" }}>
        <span className="vdot" />
        <span style={{ fontWeight: 600 }}>{label}</span>
      </div>
      <div className="level">
        <div className="level-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ProgressCard({
  events,
  large = false,
}: {
  events: AgentEvent[];
  large?: boolean;
}) {
  const stages: { key: AgentEvent["stage"]; label: string }[] = [
    { key: "intent", label: "Understanding intent" },
    { key: "researcher", label: "Researching drills" },
    { key: "youtube", label: "Reading reference video" },
    { key: "compositor", label: "Composing routine" },
    { key: "validator", label: "Validating safety" },
    { key: "videos", label: "Finding demos & moments" },
  ];
  const stageState = (k: AgentEvent["stage"]) => {
    const matching = events.filter((e) => e.stage === k);
    if (matching.length === 0) return "pending" as const;
    if (matching.some((m) => m.status === "result")) return "done" as const;
    if (matching.some((m) => m.status === "error")) return "error" as const;
    return "running" as const;
  };
  const latest = events.slice(-1)[0];
  return (
    <div className={`progress ${large ? "progress-lg" : ""}`}>
      <ul>
        {stages.map((s) => {
          const st = stageState(s.key);
          const skip = s.key === "youtube" && st === "pending";
          if (skip) return null;
          return (
            <li key={s.key} className={`progress-row p-${st}`}>
              <span className="icon">
                {st === "done" ? "✓" : st === "running" ? "" : "○"}
              </span>
              <span>{s.label}</span>
            </li>
          );
        })}
      </ul>
      {latest && (
        <div className="progress-latest mono">
          {latest.agent ?? latest.stage}: {truncate(latest.message, 60)}
        </div>
      )}
    </div>
  );
}

function RoutineOutline({
  result,
  stepIdx,
  onSelect,
  diffOpen,
}: {
  result: CompileResult;
  stepIdx: number;
  onSelect: (i: number) => void;
  diffOpen: boolean;
}) {
  const r = result.validated;
  return (
    <div className="outline">
      <div className="outline-head">
        <div className="outline-title">{r.title}</div>
        <div className="outline-sub">{r.summary}</div>
      </div>
      <ol className="outline-list">
        {r.steps.map((s, i) => {
          const v = result.videos.find((x) => x.stepIndex === i);
          return (
            <li
              key={i}
              className={`outline-step ${i === stepIdx ? "active" : ""}`}
            >
              <button onClick={() => onSelect(i)}>
                <span className="num">{i + 1}</span>
                <span className="title">{s.title}</span>
                {v && <span className="dot-video" title="video available" />}
              </button>
            </li>
          );
        })}
      </ol>
      {diffOpen && result.diffs.length > 0 && (
        <div className="diffs">
          <div className="label">Validator corrections</div>
          {result.diffs.map((d, i) => (
            <div className="diff" key={i}>
              <div className="k mono">{d.field}</div>
              <div>
                <div className="before">− {d.before}</div>
                <div className="after">+ {d.after}</div>
                <div className="why">{d.reason}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DrillRunner({
  total,
  index,
  step,
  video,
  moments,
  momentIdx,
  startT,
  autoplay,
  onPrev,
  onNext,
  onSelectMoment,
}: {
  total: number;
  index: number;
  step: { title: string; cue: string; reps: number; durationSec: number };
  video?: DrillVideo;
  moments: { t: number; caption: string; thumb: string }[];
  momentIdx: number;
  startT?: number;
  autoplay: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSelectMoment: (i: number) => void;
}) {
  return (
    <div className="drill">
      <div className="drill-head">
        <div>
          <div className="label">
            Step {index + 1} / {total}
          </div>
          <div className="drill-title">{step.title}</div>
          <div className="drill-cue">{step.cue}</div>
        </div>
        <div className="row">
          <button onClick={onPrev} disabled={index === 0} aria-label="prev">
            ←
          </button>
          <button
            className="primary"
            onClick={onNext}
            disabled={index >= total - 1}
          >
            Next →
          </button>
        </div>
      </div>
      {video ? (
        <div className="yt-embed">
          <iframe
            key={`${video.videoId}-${startT ?? 0}-${autoplay}`}
            src={`https://www.youtube.com/embed/${video.videoId}?rel=0&modestbranding=1${autoplay ? "&autoplay=1" : ""}${startT ? `&start=${startT}` : ""}`}
            title={step.title}
            allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : (
        <div className="empty-card">No video for this step yet</div>
      )}
      {moments.length > 0 && (
        <div className="moments">
          {moments.map((m, i) => (
            <button
              key={i}
              className={`moment ${i === momentIdx ? "active" : ""}`}
              onClick={() => onSelectMoment(i)}
              title={`Jump to ${fmtMmSs(m.t)}`}
            >
              <img src={m.thumb} alt="" />
              <div className="ts mono">{fmtMmSs(m.t)}</div>
              <div className="cap">{m.caption}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LiveMessages({ messages }: { messages: Message[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="messages">
      {messages.map((m, i) => (
        <div
          key={i}
          className={`bubble ${m.role}${!m.closed ? " streaming" : ""}`}
        >
          <span className="who mono">{m.role === "user" ? "you" : "coach"}</span>
          <span className="text">{m.text}</span>
        </div>
      ))}
    </div>
  );
}

function AgentDrawer({
  open,
  onToggle,
  events,
  scrollRef,
  compiling,
}: {
  open: boolean;
  onToggle: () => void;
  events: AgentEvent[];
  scrollRef: React.RefObject<HTMLDivElement>;
  compiling: boolean;
}) {
  const latest = events[events.length - 1];
  return (
    <div className={`drawer ${open ? "open" : ""}`}>
      <button className="drawer-handle" onClick={onToggle}>
        <span className="mono">
          AGENT ACTIVITY · {events.length} events
          {compiling && <span className="spin"> ⟳</span>}
        </span>
        <span style={{ flex: 1 }} />
        <span className="latest mono">
          {latest ? `${latest.agent ?? latest.stage}: ${truncate(latest.message, 80)}` : "idle"}
        </span>
        <span className="arrow">{open ? "▾" : "▴"}</span>
      </button>
      {open && (
        <div className="drawer-body" ref={scrollRef}>
          {events.length === 0 ? (
            <div className="empty">No agents running yet.</div>
          ) : (
            <div className="timeline">
              {events.map((e, i) => (
                <EventRow key={i} e={e} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EventRow({ e }: { e: AgentEvent }) {
  return (
    <div className={`evrow stage-${e.stage} status-${e.status}`}>
      <span className="evbar" />
      <span className="evagent mono">{e.agent ?? e.stage}</span>
      <span className="evmsg">{e.message}</span>
      {e.query && (
        <span className="evquery mono" title={e.query}>
          {truncate(e.query, 80)}
        </span>
      )}
      <span className="evts mono">{fmtTime(e.ts)}</span>
    </div>
  );
}

function fmtMmSs(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  });
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
