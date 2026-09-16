export type Waveform = {
  // Her çubuğun yüksekliği: 0 ile 1 arası.
  peaks: number[];
  // Saniye cinsinden ses süresi.
  duration: number;
};

export const WAVEFORM_BAR_COUNT = 40;

let audioContext: AudioContext | null = null;

// AudioContext pahalı bir nesne; bir kez oluşturulup tekrar kullanılır.
// Mikrofon kaydını wav'a çeviren kod da aynı bağlamı kullanır.
export const getAudioContext = (): AudioContext => {
  if (!audioContext) {
    audioContext = new AudioContext();
  }

  return audioContext;
};

// Ses örneklerinden çubuk yükseklikleri. Her çubuk kendi diliminin ortalama
// gücüdür (RMS); en yüksek çubuk 1 olacak şekilde ölçeklenir. Tepe değeri
// yerine RMS kullanılır, çünkü tek bir ani örnek tüm dalgayı bastırmasın.
export const computePeaks = (
  samples: Float32Array,
  barCount: number = WAVEFORM_BAR_COUNT,
): number[] => {
  if (samples.length === 0) {
    return new Array(barCount).fill(0);
  }

  const sliceSize = Math.max(Math.floor(samples.length / barCount), 1);
  const peaks: number[] = [];

  for (let barIndex = 0; barIndex < barCount; barIndex++) {
    const start = barIndex * sliceSize;
    const end = Math.min(start + sliceSize, samples.length);

    let sumOfSquares = 0;

    for (let index = start; index < end; index++) {
      sumOfSquares += samples[index] * samples[index];
    }

    const sliceLength = Math.max(end - start, 1);

    peaks.push(Math.sqrt(sumOfSquares / sliceLength));
  }

  const loudest = Math.max(...peaks);

  if (loudest === 0) {
    return peaks.map(() => 0);
  }

  return peaks.map((peak) => peak / loudest);
};

// mp3 verisini çözer. Neocortex tek kanallı ses ürettiği için ilk kanal yeterli.
// DİKKAT: decodeAudioData verilen ArrayBuffer'ı tüketir, aynı veri ikinci kez
// kullanılamaz.
export const decodeWaveform = async (
  audioData: ArrayBuffer,
  barCount: number = WAVEFORM_BAR_COUNT,
): Promise<Waveform> => {
  const audioBuffer = await getAudioContext().decodeAudioData(audioData);

  return {
    peaks: computePeaks(audioBuffer.getChannelData(0), barCount),
    duration: audioBuffer.duration,
  };
};

// Aynı tohum (mesaj ID'si) her zaman aynı deseni üretir; böylece henüz
// dinlenmemiş bir mesajın silik dalgası her çizimde zıplamaz.
const createPseudoRandom = (seed: number): (() => number) => {
  let state = (seed + 0x6d2b79f5) | 0;

  return () => {
    state = (state + 0x6d2b79f5) | 0;

    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

// Ses henüz istenmemişken gösterilen yer tutucu desen. Çubuklar 0.25 ile 0.75
// arasında kalır: gerçek dalga gibi uçlara gitmez, yer tutucu olduğu bellidir.
export const createPlaceholderPeaks = (
  seed: number,
  barCount: number = WAVEFORM_BAR_COUNT,
): number[] => {
  const random = createPseudoRandom(seed);

  return Array.from({ length: barCount }, () => 0.25 + random() * 0.5);
};

// 7.4 saniye -> "0:07". Süre bilinmiyorsa "--:--".
export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "--:--";
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
};
