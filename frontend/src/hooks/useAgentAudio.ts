import { useEffect, useRef, useState, type RefObject } from "react";
import { decodeWaveform, type Waveform } from "../waveform";

export type AudioError = {
  messageId: number;
  text: string;
};

const getAudioErrorText = (error: unknown): string => {
  // Tarayıcı, kullanıcı etkileşimi olmadan başlatılan sesi engelleyebilir.
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Tarayıcı sesi otomatik başlatmadı. Dinlemek için butona bas.";
  }

  // fetch, sunucuya hiç ulaşamadığında TypeError fırlatır.
  if (error instanceof TypeError) {
    return "Ses için sunucuya bağlanılamadı.";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Ses çalınamadı.";
};

// Agent mesajlarının sesini isteyen, çalan, durduran ve ilerlemesini takip eden
// hook. Aynı anda tek bir ses çalar. Aktif sohbet App'te tutulduğu için ref
// olarak dışarıdan alınır: ses gelene kadar sohbet değiştiyse ses çalınmaz.
export const useAgentAudio = (activeChatIdRef: RefObject<string>) => {
  const [playingMessageId, setPlayingMessageId] = useState<number | null>(null);
  const [audioLoadingMessageId, setAudioLoadingMessageId] = useState<
    number | null
  >(null);
  const [audioError, setAudioError] = useState<AudioError | null>(null);
  // Çalan sesin konumu ve toplam süresi; dalga formunun dolması için gerekir.
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  // Çözülmüş dalga formları mesaj ID'sine göre saklanır; ekranda göründüğü için
  // ref değil state. Aynı ses ikinci kez çözülmez.
  const [waveforms, setWaveforms] = useState<Map<number, Waveform>>(new Map());

  // Çalan ses, geçici adresi ve animasyon kimliği ekranda görünmez.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  // Her yeni ses isteğinde ve durdurmada artar; geç gelen eski bir ses çalınmaz.
  const audioRequestRef = useRef(0);

  const stopProgressTracking = () => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  };

  // Ses çalarken konumu her karede okur. timeupdate olayı saniyede yalnızca
  // birkaç kez tetiklendiği için dalga kesik kesik dolardı.
  const startProgressTracking = () => {
    stopProgressTracking();

    const updateProgress = () => {
      const audio = audioRef.current;

      if (!audio) {
        return;
      }

      setPlaybackTime(audio.currentTime);

      animationFrameRef.current = requestAnimationFrame(updateProgress);
    };

    animationFrameRef.current = requestAnimationFrame(updateProgress);
  };

  const stopAudio = () => {
    // Sayaç artınca yüklenmekte olan bir ses geldiğinde çalınmaz.
    audioRequestRef.current += 1;

    stopProgressTracking();

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    // Geçici adres silinmezse mp3 verisi bellekte kalmaya devam eder.
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }

    setPlayingMessageId(null);
    setAudioLoadingMessageId(null);
    setPlaybackTime(0);
    setPlaybackDuration(0);
  };

  const playMessageAudio = async (targetChatId: string, messageId: number) => {
    stopAudio();

    const requestId = audioRequestRef.current;

    setAudioLoadingMessageId(messageId);
    setAudioError(null);

    try {
      const response = await fetch(
        `http://127.0.0.1:8000/chats/${targetChatId}/messages/${messageId}/audio`,
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);

        throw new Error(errorData?.detail || "Ses alınamadı.");
      }

      const audioBlob = await response.blob();

      // Ses gelene kadar başka bir ses istendiyse, ses durdurulduysa veya
      // sohbet değiştiyse gelen ses artık geçersizdir.
      if (
        requestId !== audioRequestRef.current ||
        activeChatIdRef.current !== targetChatId
      ) {
        return;
      }

      // Dalga formu yalnızca ilk dinlemede hesaplanır.
      let waveform = waveforms.get(messageId) ?? null;

      if (!waveform) {
        try {
          waveform = await decodeWaveform(await audioBlob.arrayBuffer());

          setWaveforms((previousWaveforms) =>
            new Map(previousWaveforms).set(messageId, waveform as Waveform),
          );
        } catch (decodeError) {
          // Dalga formu çizilemese de ses çalınabilir.
          console.error("Dalga formu hesaplanamadı:", decodeError);
        }
      }

      if (
        requestId !== audioRequestRef.current ||
        activeChatIdRef.current !== targetChatId
      ) {
        return;
      }

      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      audioRef.current = audio;
      audioUrlRef.current = audioUrl;

      setAudioLoadingMessageId(null);
      setPlayingMessageId(messageId);
      setPlaybackTime(0);
      setPlaybackDuration(waveform?.duration ?? 0);

      // Çözme başarısız olduysa süre ses dosyasının kendisinden öğrenilir.
      audio.onloadedmetadata = () => {
        if (audioRef.current === audio && Number.isFinite(audio.duration)) {
          setPlaybackDuration(audio.duration);
        }
      };

      audio.onended = () => {
        // Bu arada başka bir ses başladıysa onun durumu silinmez.
        if (audioRef.current === audio) {
          stopAudio();
        }
      };

      await audio.play();

      startProgressTracking();
    } catch (error) {
      // Kullanıcı sesi kendisi durdurduysa veya başka bir ses istediyse
      // eski isteğin hatası gösterilmez.
      if (requestId !== audioRequestRef.current) {
        return;
      }

      console.error("Ses çalma hatası:", error);

      stopAudio();
      setAudioError({
        messageId,
        text: getAudioErrorText(error),
      });
    }
  };

  const toggleMessageAudio = (targetChatId: string, messageId: number) => {
    // Çalan veya yüklenen mesajın butonuna tekrar basmak sesi durdurur.
    if (playingMessageId === messageId || audioLoadingMessageId === messageId) {
      stopAudio();
      return;
    }

    playMessageAudio(targetChatId, messageId);
  };

  // Dalga üzerinde bir noktaya tıklanınca sesin o anına atlar.
  const seekTo = (seconds: number) => {
    const audio = audioRef.current;

    if (!audio || !Number.isFinite(seconds)) {
      return;
    }

    const safeSeconds = Math.min(Math.max(seconds, 0), playbackDuration || 0);

    audio.currentTime = safeSeconds;
    setPlaybackTime(safeSeconds);
  };

  // Sayfa kapanırken çalan ses ve zamanlayıcı bırakılır.
  useEffect(() => {
    return () => {
      stopProgressTracking();

      audioRef.current?.pause();
      audioRef.current = null;

      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);

  return {
    playingMessageId,
    audioLoadingMessageId,
    audioError,
    playbackTime,
    playbackDuration,
    waveforms,
    stopAudio,
    playMessageAudio,
    toggleMessageAudio,
    seekTo,
  };
};
