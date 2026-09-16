import { useRef, useState } from "react";
import { convertRecordingToWav } from "../wav";

export type RecorderStatus = "idle" | "recording" | "processing" | "error";

// 0.3 saniyeden kısa kayıtlar gönderilmez: yanlışlıkla iki kez basmak
// Neocortex'e boş bir kayıt göndermesin.
const MIN_RECORDING_MS = 300;

const getRecorderErrorText = (error: unknown): string => {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Mikrofon izni verilmedi.";
    }

    if (error.name === "NotFoundError") {
      return "Mikrofon bulunamadı.";
    }
  }

  if (error instanceof TypeError) {
    return "Sunucuya bağlanılamadı.";
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Ses kaydedilemedi.";
};

// Mikrofondan kaydeder, kaydı wav'a çevirip backend'e yollar ve yazıya
// çevrilmiş metni onTranscript ile bildirir.
export const useVoiceRecorder = (onTranscript: (text: string) => void) => {
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>("idle");
  const [recorderError, setRecorderError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);

  // Kayıt bitince mikrofon bırakılır; tarayıcıdaki kırmızı nokta böylece söner.
  const releaseMicrophone = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
  };

  const transcribeRecording = async (recording: Blob) => {
    setRecorderStatus("processing");

    try {
      const wavBlob = await convertRecordingToWav(recording);

      const formData = new FormData();
      formData.append("audio", wavBlob, "audio.wav");

      const response = await fetch("http://127.0.0.1:8000/agent/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);

        throw new Error(errorData?.detail || "Ses yazıya çevrilemedi.");
      }

      const data = await response.json();
      const text = (data.text || "").trim();

      if (!text) {
        throw new Error("Ses anlaşılamadı, tekrar dene.");
      }

      setRecorderStatus("idle");
      onTranscript(text);
    } catch (error) {
      console.error("Ses yazıya çevrilemedi:", error);

      setRecorderStatus("error");
      setRecorderError(getRecorderErrorText(error));
    }
  };

  const startRecording = async () => {
    setRecorderError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);

      streamRef.current = stream;
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      startedAtRef.current = Date.now();

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const recordedMs = Date.now() - startedAtRef.current;
        const recording = new Blob(chunksRef.current, {
          type: mediaRecorder.mimeType,
        });

        releaseMicrophone();

        if (recordedMs < MIN_RECORDING_MS || recording.size === 0) {
          setRecorderStatus("idle");
          return;
        }

        transcribeRecording(recording);
      };

      mediaRecorder.start();
      setRecorderStatus("recording");
    } catch (error) {
      console.error("Mikrofon açılamadı:", error);

      releaseMicrophone();
      setRecorderStatus("error");
      setRecorderError(getRecorderErrorText(error));
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  };

  const toggleRecording = () => {
    if (recorderStatus === "recording") {
      stopRecording();
      return;
    }

    if (recorderStatus === "processing") {
      return;
    }

    startRecording();
  };

  return {
    recorderStatus,
    recorderError,
    toggleRecording,
    stopRecording,
  };
};
