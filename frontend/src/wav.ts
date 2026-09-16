import { getAudioContext } from "./waveform";

const WAV_HEADER_SIZE = 44;
const BYTES_PER_SAMPLE = 2;

const writeText = (view: DataView, offset: number, text: string) => {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
};

// Çözülmüş sesi tek kanallı 16-bit PCM wav'a çevirir. Neocortex'in resmi SDK'sı
// da bu biçimi gönderiyor; denemeyle çalıştığını doğruladık.
export const encodeWav = (audioBuffer: AudioBuffer): Blob => {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleCount = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;

  const channels: Float32Array[] = [];

  for (let channel = 0; channel < channelCount; channel++) {
    channels.push(audioBuffer.getChannelData(channel));
  }

  const dataSize = sampleCount * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_SIZE + dataSize);
  const view = new DataView(buffer);

  // RIFF/WAVE başlığı: 16-bit, tek kanal.
  writeText(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(view, 8, "WAVE");
  writeText(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeText(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = WAV_HEADER_SIZE;

  for (let index = 0; index < sampleCount; index++) {
    // Kanallar ortalanarak tek kanala indirilir.
    let total = 0;

    for (let channel = 0; channel < channelCount; channel++) {
      total += channels[channel][index];
    }

    const sample = Math.max(-1, Math.min(1, total / channelCount));

    view.setInt16(
      offset,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );

    offset += BYTES_PER_SAMPLE;
  }

  return new Blob([buffer], { type: "audio/wav" });
};

// Tarayıcının kaydettiği dosyayı (Chrome'da webm/Opus) wav'a çevirir.
export const convertRecordingToWav = async (recording: Blob): Promise<Blob> => {
  const audioBuffer = await getAudioContext().decodeAudioData(
    await recording.arrayBuffer(),
  );

  return encodeWav(audioBuffer);
};
