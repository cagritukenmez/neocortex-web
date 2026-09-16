import { formatDuration } from "../waveform";
import { WaveformBars } from "./WaveformBars";

export type VoiceMessageStatus = "idle" | "loading" | "playing" | "error";

type VoiceMessageProps = {
  // 0 ile 1 arası çubuk yükseklikleri. Ses henüz çözülmediyse yer tutucu desen.
  peaks: number[];
  hasRealWaveform: boolean;
  status: VoiceMessageStatus;
  currentTime: number;
  duration: number;
  errorText?: string;
  onToggle: () => void;
  // Dalganın neresine tıklandığı: 0 (baş) ile 1 (son) arası.
  onSeek: (ratio: number) => void;
};

const STATUS_ICONS: Record<VoiceMessageStatus, string> = {
  idle: "▶",
  loading: "⏳",
  playing: "⏸",
  error: "↻",
};

const STATUS_TITLES: Record<VoiceMessageStatus, string> = {
  idle: "Sesi çal",
  loading: "Ses hazırlanıyor, durdurmak için bas",
  playing: "Sesi duraklat",
  error: "Tekrar dene",
};

export const VoiceMessage = ({
  peaks,
  hasRealWaveform,
  status,
  currentTime,
  duration,
  errorText,
  onToggle,
  onSeek,
}: VoiceMessageProps) => {
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
    <div
      className={`voice-message ${status}${
        hasRealWaveform ? "" : " is-placeholder"
      }`}
    >
      <button
        type="button"
        className="voice-message-button"
        title={STATUS_TITLES[status]}
        aria-label={STATUS_TITLES[status]}
        onClick={onToggle}
      >
        {STATUS_ICONS[status]}
      </button>

      {status === "error" ? (
        <span className="voice-message-error">
          {errorText || "Ses alınamadı."}
        </span>
      ) : (
        <>
          <div
            className="voice-message-wave"
            onClick={handleWaveClick}
            title={status === "playing" ? "Atlamak için tıkla" : undefined}
          >
            <WaveformBars peaks={peaks} progress={progress} />
          </div>

          <span className="voice-message-time">
            {status === "playing"
              ? `${formatDuration(currentTime)} / ${formatDuration(duration)}`
              : formatDuration(duration > 0 ? duration : Number.NaN)}
          </span>
        </>
      )}
    </div>
  );
};
