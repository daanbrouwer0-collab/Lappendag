// Lappendag Rave Afterparty - Audio Engine

const tracks = [
  {
    id: 1,
    title: "Lappendag Rave Set 1 - Deel 1",
    file: "Lap-set/Lap-set-1-5-1.mp3",
    tag: "High Energy Techno / Dance"
  },
  {
    id: 2,
    title: "Lappendag Rave Set 1 - Deel 2",
    file: "Lap-set/Lap-set-1-5-2.mp3",
    tag: "Deep Bass & Acid"
  },
  {
    id: 3,
    title: "Lappendag Rave Set 2 - Deel 1",
    file: "Lap-set/Lap-set-2-4-1.mp3",
    tag: "Peak Time Hard Groove"
  },
  {
    id: 4,
    title: "Lappendag Rave Set 2 - Deel 2",
    file: "Lap-set/Lap-set-2-4-2.mp3",
    tag: "Industrial & Hard Dance"
  },
  {
    id: 5,
    title: "Lappendag Rave Set 2 - Deel 3",
    file: "Lap-set/Lap-set-2-4-3.mp3",
    tag: "Marathon Rave Special"
  },
  {
    id: 6,
    title: "Lappendag Rave Set 3 - Deel 1",
    file: "Lap-set/Lap-set-3-3-1.mp3",
    tag: "Trance & Euphoric Grooves"
  },
  {
    id: 7,
    title: "Lappendag Rave Set 3 - Deel 2",
    file: "Lap-set/Lap-set-3-3-2.mp3",
    tag: "Hardstyle & Afterparty Bangers"
  },
  {
    id: 8,
    title: "Lappendag Rave Set 3 - Deel 3",
    file: "Lap-set/Lap-set-3-3-3.mp3",
    tag: "Extended Rave Energy"
  },
  {
    id: 9,
    title: "Lappendag Rave Set 3 - Deel 4",
    file: "Lap-set/Lap-set-3-3-4.mp3",
    tag: "Final Madness & Closing Track"
  }
];

// DOM Elements
const audio = document.getElementById('audioPlayer');
const playBtn = document.getElementById('playBtn');
const playIcon = document.getElementById('playIcon');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const speedBtn = document.getElementById('speedBtn');
const speedLabel = document.getElementById('speedLabel');
const muteBtn = document.getElementById('muteBtn');
const volIcon = document.getElementById('volIcon');
const volumeSlider = document.getElementById('volumeSlider');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
const currentTitle = document.getElementById('currentTitle');
const currentArtist = document.getElementById('currentArtist');
const playlistEl = document.getElementById('playlist');
const disc = document.getElementById('disc');
const eqBars = document.getElementById('eqBars');

// State
let currentIndex = 0;
let isPlaying = false;
let isSeeking = false;
const playbackSpeeds = [1.0, 1.15, 1.25, 1.5, 0.85];
let speedIndex = 0;

// Initialize
function initPlayer() {
  renderPlaylist();
  loadTrack(currentIndex, false);
  
  // Event listeners
  playBtn.addEventListener('click', togglePlay);
  prevBtn.addEventListener('click', playPrevious);
  nextBtn.addEventListener('click', playNext);
  speedBtn.addEventListener('click', toggleSpeed);
  muteBtn.addEventListener('click', toggleMute);

  // Audio element events
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('loadedmetadata', handleMetadataLoaded);
  audio.addEventListener('ended', playNext);
  
  // Scrubber events
  progressBar.addEventListener('input', onScrubberInput);
  progressBar.addEventListener('change', onScrubberChange);
  
  // Volume event
  volumeSlider.addEventListener('input', (e) => {
    audio.volume = e.target.value;
    updateVolumeIcon(e.target.value);
  });
}

// Render Playlist UI
function renderPlaylist() {
  const trackCountEl = document.getElementById('trackCount');
  if (trackCountEl) {
    trackCountEl.textContent = `${tracks.length} Tracks`;
  }

  playlistEl.innerHTML = '';
  tracks.forEach((track, index) => {
    const item = document.createElement('div');
    item.className = `track-item ${index === currentIndex ? 'active' : ''}`;
    item.onclick = () => selectTrack(index);

    item.innerHTML = `
      <div class="track-num">${String(index + 1).padStart(2, '0')}</div>
      <div class="track-details">
        <div class="track-name">${track.title}</div>
        <div class="track-sub">${track.tag}</div>
      </div>
      <div class="track-play-icon">
        <i class="fa-solid ${index === currentIndex && isPlaying ? 'fa-chart-simple' : 'fa-circle-play'}"></i>
      </div>
    `;
    playlistEl.appendChild(item);
  });
}

// Load track into audio engine
function loadTrack(index, shouldPlay = true) {
  currentIndex = index;
  const track = tracks[currentIndex];
  audio.src = track.file;
  currentTitle.textContent = track.title;
  currentArtist.textContent = track.tag;

  // Reset scrubber & time
  progressBar.value = 0;
  progressFill.style.width = '0%';
  currentTimeEl.textContent = '00:00:00';
  durationEl.textContent = '--:--:--';

  renderPlaylist();

  if (shouldPlay) {
    playTrack();
  }
}

// Toggle Play/Pause
function togglePlay() {
  if (isPlaying) {
    pauseTrack();
  } else {
    playTrack();
  }
}

function playTrack() {
  audio.play().then(() => {
    isPlaying = true;
    playIcon.className = 'fa-solid fa-pause';
    disc.classList.add('spinning');
    eqBars.classList.add('playing');
    renderPlaylist();
  }).catch(err => {
    console.error("Playback error:", err);
  });
}

function pauseTrack() {
  audio.pause();
  isPlaying = false;
  playIcon.className = 'fa-solid fa-play';
  disc.classList.remove('spinning');
  eqBars.classList.remove('playing');
  renderPlaylist();
}

function playNext() {
  const nextIndex = (currentIndex + 1) % tracks.length;
  loadTrack(nextIndex, true);
}

function playPrevious() {
  const prevIndex = (currentIndex - 1 + tracks.length) % tracks.length;
  loadTrack(prevIndex, true);
}

function selectTrack(index) {
  if (currentIndex === index && isPlaying) {
    pauseTrack();
  } else {
    loadTrack(index, true);
  }
}

// Scrubber / Progress Logic
function handleMetadataLoaded() {
  durationEl.textContent = formatTime(audio.duration);
}

function updateProgress() {
  if (!isSeeking && audio.duration) {
    const percent = (audio.currentTime / audio.duration) * 100;
    progressBar.value = percent;
    progressFill.style.width = `${percent}%`;
    currentTimeEl.textContent = formatTime(audio.currentTime);
  }
}

function onScrubberInput(e) {
  isSeeking = true;
  const percent = e.target.value;
  progressFill.style.width = `${percent}%`;
  if (audio.duration) {
    currentTimeEl.textContent = formatTime((percent / 100) * audio.duration);
  }
}

function onScrubberChange(e) {
  if (audio.duration) {
    const percent = e.target.value;
    audio.currentTime = (percent / 100) * audio.duration;
  }
  isSeeking = false;
}

// Format time in HH:MM:SS or MM:SS
function formatTime(seconds) {
  if (isNaN(seconds)) return "00:00:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const formattedMins = String(mins).padStart(2, '0');
  const formattedSecs = String(secs).padStart(2, '0');

  if (hrs > 0) {
    const formattedHrs = String(hrs).padStart(2, '0');
    return `${formattedHrs}:${formattedMins}:${formattedSecs}`;
  }
  return `00:${formattedMins}:${formattedSecs}`;
}

// Playback Speed Toggle
function toggleSpeed() {
  speedIndex = (speedIndex + 1) % playbackSpeeds.length;
  const newSpeed = playbackSpeeds[speedIndex];
  audio.playbackRate = newSpeed;
  speedLabel.textContent = `${newSpeed.toFixed(2).replace('.00', '.0')}x`;
}

// Mute & Volume Logic
function toggleMute() {
  audio.muted = !audio.muted;
  if (audio.muted) {
    volIcon.className = 'fa-solid fa-volume-xmark';
  } else {
    updateVolumeIcon(audio.volume);
  }
}

function updateVolumeIcon(vol) {
  if (vol == 0) {
    volIcon.className = 'fa-solid fa-volume-xmark';
  } else if (vol < 0.5) {
    volIcon.className = 'fa-solid fa-volume-low';
  } else {
    volIcon.className = 'fa-solid fa-volume-high';
  }
}

// Run on load
document.addEventListener('DOMContentLoaded', initPlayer);
