// Short tones (WebAudio): recording started / ended / cancelled, an answer arrived.
let actx = null;
function tone(freqs, dur = 0.1, gap = 0.11, vol = 0.14) {
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    freqs.forEach((f, i) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      const t = actx.currentTime + i * gap;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.03);
    });
  } catch { /* no sound on this device */ }
}
export const SOUND = {
  recStart: () => tone([880]),
  recStop: () => tone([587]),
  recCancel: () => tone([330], 0.14),
  answer: () => tone([784, 1047, 1319], 0.22, 0.13, 0.16),
};
