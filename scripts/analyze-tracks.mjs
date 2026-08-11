import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMixPointsFromMono } from './mix-analysis.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SET_DIR = path.join(ROOT, 'Lap-set');
const OUT = path.join(ROOT, 'tracks.json');
const SAMPLE_RATE = 8000; // enough for RMS energy; keeps decode lighter

function decodeMonoF32(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', filePath,
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le',
      '-v', 'error',
      'pipe:1',
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => { err += c.toString(); });
    ff.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg failed for ${filePath}: ${err || code}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
    });
  });
}

function parseLapId(name) {
  const m = /^Lap_(\d+)\.mp3$/i.exec(name);
  return m ? Number(m[1]) : null;
}

async function main() {
  const names = (await readdir(SET_DIR))
    .filter((n) => parseLapId(n) != null)
    .sort((a, b) => parseLapId(a) - parseLapId(b));

  if (!names.length) {
    throw new Error(`No Lap_*.mp3 in ${SET_DIR}`);
  }

  const tracks = [];
  for (const name of names) {
    const id = parseLapId(name);
    const filePath = path.join(SET_DIR, name);
    process.stderr.write(`Analyzing ${name}...\n`);
    const samples = await decodeMonoF32(filePath);
    const { introSec, outroSec } = analyzeMixPointsFromMono(samples, SAMPLE_RATE);
    tracks.push({
      id,
      title: `Lap_${id}`,
      file: `Lap-set/Lap_${id}.mp3`,
      introSec,
      outroSec,
    });
  }

  const payload = { tracks };
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stderr.write(`Wrote ${tracks.length} tracks → ${OUT}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
