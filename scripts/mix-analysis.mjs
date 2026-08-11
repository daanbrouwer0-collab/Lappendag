/** Pure mix intro/outro helpers (shared by offline analyzer + tests). */

export const MIX_MIN_SEC = 2;
export const MIX_MAX_SEC = 12;
export const MIX_DEFAULT_SEC = 6;
export const AUTO_MIX_MIN_SEC = 3.5;

export function clampAutoMixSec(sec) {
  return Math.min(MIX_MAX_SEC, Math.max(AUTO_MIX_MIN_SEC, sec));
}

export function blendMixSec(outroSec, introSec, trackDuration = null) {
  let sec = Number(outroSec) * 0.55 + Number(introSec) * 0.45;
  sec = clampAutoMixSec(sec);
  if (trackDuration && Number.isFinite(trackDuration) && trackDuration > 0) {
    sec = Math.min(sec, Math.max(AUTO_MIX_MIN_SEC, trackDuration * 0.4));
  }
  return Math.round(sec * 10) / 10;
}

/**
 * @param {Float32Array} samples mono PCM
 * @param {number} sampleRate
 * @param {number} [winSec=0.05]
 */
export function buildRmsEnvelope(samples, sampleRate, winSec = 0.05) {
  const sr = sampleRate;
  const win = Math.max(1, Math.floor(sr * winSec));
  const n = Math.floor(samples.length / win);
  const rms = new Float32Array(Math.max(0, n));
  if (n < 4) return { rms, winSec, peak: 0 };

  let peak = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * win;
    for (let j = 0; j < win; j++) {
      const v = samples[base + j];
      sum += v * v;
    }
    rms[i] = Math.sqrt(sum / win);
    if (rms[i] > peak) peak = rms[i];
  }

  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rms[Math.max(0, i - 1)];
    const b = rms[i];
    const c = rms[Math.min(n - 1, i + 1)];
    smooth[i] = (a + b * 2 + c) / 4;
  }
  return { rms: smooth, winSec, peak };
}

function regionPeak(rms, from, to) {
  let peak = 0;
  for (let i = from; i <= to; i++) {
    if (rms[i] > peak) peak = rms[i];
  }
  return peak;
}

export function measureOutroSec(rms, winSec, globalPeak) {
  const n = rms.length;
  const silent = globalPeak * 0.04;
  let end = n - 1;
  while (end > 0 && rms[end] < silent) end -= 1;

  const lookBins = Math.min(end + 1, Math.floor(16 / winSec));
  const region0 = Math.max(0, end - lookBins + 1);
  const localPeak = regionPeak(rms, region0, end);
  if (localPeak < 1e-6) return 2.5;

  const high = localPeak * 0.72;
  const low = localPeak * 0.28;

  let lastHigh = region0;
  for (let i = end; i >= region0; i--) {
    if (rms[i] >= high) {
      lastHigh = i;
      break;
    }
  }

  let firstLow = end;
  for (let i = lastHigh; i <= end; i++) {
    if (rms[i] <= low) {
      firstLow = i;
      break;
    }
  }

  let outro = (firstLow - lastHigh) * winSec;

  if (lastHigh >= end - Math.floor(0.25 / winSec)) {
    const back = Math.max(region0, end - Math.floor(4 / winSec));
    const earlier = regionPeak(rms, back, Math.max(back, end - Math.floor(1 / winSec)));
    const ratio = earlier > 1e-6 ? rms[end] / earlier : 1;
    outro = ratio < 0.8 ? 4.5 + (1 - ratio) * 5 : 5.0;
  }

  const trailing = ((n - 1) - end) * winSec;
  outro += Math.min(trailing, 2.5) * 0.4;

  return Math.min(MIX_MAX_SEC, Math.max(AUTO_MIX_MIN_SEC, outro));
}

export function measureIntroSec(rms, winSec, globalPeak) {
  const n = rms.length;
  const silent = globalPeak * 0.04;
  let start = 0;
  while (start < n - 1 && rms[start] < silent) start += 1;

  const lookBins = Math.min(n - start, Math.floor(16 / winSec));
  const region1 = Math.min(n - 1, start + lookBins - 1);
  const localPeak = regionPeak(rms, start, region1);
  if (localPeak < 1e-6) return 2.5;

  const high = localPeak * 0.7;
  let riseEnd = start;
  for (let i = start; i <= region1; i++) {
    riseEnd = i;
    if (rms[i] >= high) break;
  }

  let intro = (riseEnd - start) * winSec;
  const leading = start * winSec;
  intro += Math.min(leading, 2.5) * 0.35;

  if (riseEnd <= start + Math.floor(0.2 / winSec) && leading < 0.15) {
    intro = 4.5;
  }

  return Math.min(MIX_MAX_SEC, Math.max(AUTO_MIX_MIN_SEC, intro));
}

export function analyzeMixPointsFromMono(samples, sampleRate) {
  const { rms, winSec, peak } = buildRmsEnvelope(samples, sampleRate, 0.05);
  if (rms.length < 4 || peak < 1e-5) {
    return { introSec: MIX_DEFAULT_SEC, outroSec: MIX_DEFAULT_SEC };
  }

  return {
    introSec: measureIntroSec(rms, winSec, peak),
    outroSec: measureOutroSec(rms, winSec, peak),
  };
}
