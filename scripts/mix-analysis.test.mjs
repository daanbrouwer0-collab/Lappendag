import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  blendMixSec,
  clampAutoMixSec,
  AUTO_MIX_MIN_SEC,
  MIX_MAX_SEC,
  analyzeMixPointsFromMono,
} from './mix-analysis.mjs';

describe('clampAutoMixSec', () => {
  it('clamps below min up to AUTO_MIX_MIN_SEC', () => {
    assert.equal(clampAutoMixSec(1), AUTO_MIX_MIN_SEC);
  });
  it('clamps above max down to MIX_MAX_SEC', () => {
    assert.equal(clampAutoMixSec(99), MIX_MAX_SEC);
  });
});

describe('blendMixSec', () => {
  it('blends outro*0.55 + intro*0.45 and rounds to 0.1s', () => {
    // 5*0.55 + 7*0.45 = 2.75+3.15 = 5.9
    assert.equal(blendMixSec(5, 7), 5.9);
  });
  it('falls back toward defaults via clamp when tiny', () => {
    assert.equal(blendMixSec(0.1, 0.1), AUTO_MIX_MIN_SEC);
  });
  it('caps against short track duration', () => {
    const sec = blendMixSec(10, 10, 8); // raw ~10, duration*0.4 = 3.2 → clamp to AUTO_MIX_MIN_SEC
    assert.equal(sec, AUTO_MIX_MIN_SEC);
  });
});

describe('analyzeMixPointsFromMono', () => {
  it('detects cold-open-ish intro and trailing outro on synthetic audio', () => {
    const sr = 1000;
    const seconds = 20;
    const samples = new Float32Array(sr * seconds);
    // silence 0-1s, then full level, then fade 16-20s
    for (let i = 0; i < samples.length; i++) {
      const t = i / sr;
      if (t < 1) samples[i] = 0;
      else if (t < 16) samples[i] = 0.5;
      else samples[i] = 0.5 * (1 - (t - 16) / 4);
    }
    const { introSec, outroSec } = analyzeMixPointsFromMono(samples, sr);
    assert.ok(introSec >= AUTO_MIX_MIN_SEC && introSec <= MIX_MAX_SEC);
    assert.ok(outroSec >= AUTO_MIX_MIN_SEC && outroSec <= MIX_MAX_SEC);
    assert.ok(outroSec >= 3, `expected meaningful outro, got ${outroSec}`);
  });
});
