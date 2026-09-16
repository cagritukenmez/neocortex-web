type WaveformBarsProps = {
  // 0 ile 1 arası çubuk yükseklikleri.
  peaks: number[];
  // Dinlenen kısım: 0 (hiç) ile 1 (tamamı) arası.
  progress: number;
};

// Yalnızca çubukları çizer. Tıklama davranışı kapsayıcıya bırakılır: balonda
// ve sahnede farklı davranıyor.
export const WaveformBars = ({ peaks, progress }: WaveformBarsProps) => (
  <>
    {peaks.map((peak, index) => (
      <span
        key={index}
        className={`voice-wave-bar${
          index / peaks.length < progress ? " played" : ""
        }`}
        // Çok alçak çubuklar da görünsün diye taban yükseklik verilir.
        style={{ height: `${Math.max(peak * 100, 12)}%` }}
      />
    ))}
  </>
);
