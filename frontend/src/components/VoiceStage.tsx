import { formatDuration } from "../waveform";
import { WaveformBars } from "./WaveformBars";

export type VoiceStageStatus =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "loading"
  | "playing"
  | "error";

type VoiceStageProps = {
  // Agent'ın son duygusu; yoksa yerini boş bırakmamak için 🤖 gösterilir.
  emoji?: string | null;
  status: VoiceStageStatus;
  // Çalınabilecek bir cevap var mı? Yoksa oynatıcı hiç çizilmez.
  canPlay: boolean;
  peaks: number[];
  hasRealWaveform: boolean;
  currentTime: number;
  duration: number;
  errorText?: string;
  onToggle: () => void;
  onSeek: (ratio: number) => void;
};

const STATUS_TEXTS: Record<VoiceStageStatus, string> = {
  idle: "Konuşmak için mikrofona bas",
  listening: "🎤 Dinliyorum… bitirmek için tekrar bas",
  transcribing: "✍️ Söylediklerin yazıya çevriliyor…",
  thinking: "💭 Düşünüyor…",
  loading: "⏳ Ses hazırlanıyor…",
  playing: "🔊 Konuşuyor",
  error: "⚠ Ses alınamadı",
};

export const VoiceStage = ({
  emoji,
  status,
  canPlay,
  peaks,
  hasRealWaveform,
  currentTime,
  duration,
  errorText,
  onToggle,
  onSeek,
}: VoiceStageProps) => {
  const progress =
    status === "playing" && duration > 0
      ? Math.min(currentTime / duration, 1)
      : 0;

  const handleWaveClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // Ses çalmıyorken dalgaya basmak sesi başlatır; çalarken o ana atlar.
    if (status !== "playing") {
      onToggle();
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - bounds.left) / bounds.width;

    onSeek(Math.min(Math.max(ratio, 0), 1));
  };

  return (
    <section
      className={`voice-stage ${status}${
        hasRealWaveform ? "" : " is-placeholder"
      }`}
      aria-live="polite"
    >
      <div className="voice-stage-avatar">{emoji || "🤖"}</div>

      {canPlay && (
        <div className="voice-stage-player">
          <button
            type="button"
            className="voice-stage-button"
            title={
              status === "playing"
                ? "Sesi duraklat"
                : status === "error"
                  ? "Tekrar dene"
                  : "Sesi çal"
            }
            onClick={onToggle}
          >
            {status === "playing"
              ? "⏸"
              : status === "loading"
                ? "⏳"
                : status === "error"
                  ? "↻"
                  : "▶"}
          </button>

          <div
            className="voice-stage-wave"
            onClick={handleWaveClick}
            title={status === "playing" ? "Atlamak için tıkla" : undefined}
          >
            <WaveformBars peaks={peaks} progress={progress} />
          </div>

          <span className="voice-stage-time">
            {status === "playing"
              ? `${formatDuration(currentTime)} / ${formatDuration(duration)}`
              : formatDuration(duration > 0 ? duration : Number.NaN)}
          </span>
        </div>
      )}

      <p className="voice-stage-status">
        {status === "error"
          ? errorText || STATUS_TEXTS.error
          : STATUS_TEXTS[status]}
      </p>
    </section>
  );
};
