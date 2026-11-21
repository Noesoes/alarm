import { PushUpCounter, LM } from './pushup.js';

const MEDIAPIPE_VERSION = '0.10.14';
const VISION_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const STORE_KEY = 'pushup-alarm';

const $ = (id) => document.getElementById(id);
const screens = { setup: $('setup'), ringing: $('ringing'), done: $('done') };
function show(name) {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== name);
}

// ---------- persisted state ----------
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function save(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch {}
}
let state = { time: '07:00', reps: 10, nextFire: null, ringing: false, ...load() };

$('alarmTime').value = state.time;
$('repTarget').value = state.reps;

// ---------- clock ----------
const fmt = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function tick() {
  const now = new Date();
  $('clock').textContent = fmt(now);
  $('ringClock').textContent = fmt(now);
  if (state.nextFire && !state.ringing && Date.now() >= state.nextFire) startRinging();
}
setInterval(tick, 1000);
tick();

function nextOccurrence(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function renderSetup() {
  const armed = !!state.nextFire;
  $('cancelBtn').classList.toggle('hidden', !armed);
  $('setBtn').textContent = armed ? 'Update alarm' : 'Set alarm';
  if (armed) {
    const mins = Math.round((state.nextFire - Date.now()) / 60000);
    const h = Math.floor(mins / 60), m = mins % 60;
    $('status').textContent = `Alarm set for ${fmt(new Date(state.nextFire))} (in ${h}h ${m}m). Keep this page open.`;
  } else {
    $('status').textContent = '';
  }
}

// ---------- screen wake lock ----------
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported or denied */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (state.nextFire || state.ringing) keepAwake(true);
    tick();
  }
});

// ---------- alarm sound (generated, no audio files) ----------
let audioCtx = null, beepTimer = null, master = null;
function unlockAudio() {
  // Must be created from a user tap, or browsers block the sound later.
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    master = audioCtx.createGain();
    master.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
function beep(freq, start, dur) {
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(1, start + 0.01);
  g.gain.setValueAtTime(1, start + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, start + dur);
  osc.connect(g).connect(master);
  osc.start(start);
  osc.stop(start + dur);
}
function startSound() {
  stopSound();
  unlockAudio();
  master.gain.value = 0.9;
  const pattern = () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime + 0.05;
    for (let i = 0; i < 4; i++) beep(i % 2 ? 1320 : 990, t + i * 0.15, 0.12);
    navigator.vibrate?.([400, 200, 400]);
  };
  pattern();
  beepTimer = setInterval(pattern, 1000);
}
function stopSound() {
  clearInterval(beepTimer);
  beepTimer = null;
  navigator.vibrate?.(0);
}

// ---------- pose detection ----------
let landmarker = null, stream = null, rafId = null;
const counter = new PushUpCounter();

async function loadLandmarker() {
  if (landmarker) return landmarker;
  const { FilesetResolver, PoseLandmarker } = await import(`${VISION_URL}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    landmarker = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
  }
  return landmarker;
}

async function startCamera() {
  const video = $('video');
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

function stopCamera() {
  cancelAnimationFrame(rafId);
  rafId = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

const BONES = [
  [LM.L_SHOULDER, LM.R_SHOULDER], [LM.L_HIP, LM.R_HIP],
  [LM.L_SHOULDER, LM.L_ELBOW], [LM.L_ELBOW, LM.L_WRIST],
  [LM.R_SHOULDER, LM.R_ELBOW], [LM.R_ELBOW, LM.R_WRIST],
  [LM.L_SHOULDER, LM.L_HIP], [LM.R_SHOULDER, LM.R_HIP],
  [23, 25], [25, 27], [24, 26], [26, 28],
];
function draw(lm, phase) {
  const video = $('video'), canvas = $('overlay');
  const w = video.videoWidth, h = video.videoHeight;
  if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!lm) return;
  ctx.lineWidth = 4;
  ctx.strokeStyle = phase === 'down' ? '#ffcc00' : phase === 'up' ? '#3ddc84' : '#ffffff';
  for (const [a, b] of BONES) {
    if ((lm[a].visibility ?? 1) < 0.4 || (lm[b].visibility ?? 1) < 0.4) continue;
    ctx.beginPath();
    ctx.moveTo(lm[a].x * w, lm[a].y * h);
    ctx.lineTo(lm[b].x * w, lm[b].y * h);
    ctx.stroke();
  }
}

function loop() {
  const video = $('video');
  if (!landmarker || !stream) return;
  if (video.readyState >= 2) {
    const now = performance.now();
    const res = landmarker.detectForVideo(video, now);
    const lm = res.landmarks?.[0] ?? null;
    const aspect = video.videoWidth / video.videoHeight || 1;
    const r = counter.update(lm, now, aspect);
    draw(lm, r.phase);
    $('hint').textContent = r.message;
    if (r.repCounted) onRep(r.count);
  }
  rafId = requestAnimationFrame(loop);
}

function onRep(count) {
  const goal = state.reps;
  $('repCount').textContent = count;
  $('meterFill').style.width = `${Math.min(100, (count / goal) * 100)}%`;
  // Ease the volume down a little as you make progress.
  if (master) master.gain.value = Math.max(0.3, 0.9 * (1 - count / goal));
  if (count >= goal) finish();
}

// ---------- ringing flow ----------
async function startRinging() {
  state.ringing = true;
  state.nextFire = null;
  save(state);

  counter.reset();
  $('repGoal').textContent = state.reps;
  $('repCount').textContent = '0';
  $('meterFill').style.width = '0';
  $('hint').textContent = 'Get into push-up position, side-on to the camera.';
  show('ringing');
  keepAwake(true);
  startSound();

  const msg = $('camMsg');
  try {
    msg.textContent = 'Starting camera…';
    await startCamera();
    msg.textContent = 'Loading push-up detector…';
    await loadLandmarker();
    msg.textContent = '';
    loop();
  } catch (err) {
    console.error(err);
    msg.textContent =
      err?.name === 'NotAllowedError'
        ? 'Camera blocked. Allow camera access for this site, then tap here.'
        : 'Couldn’t start the camera or detector. Tap here to retry.';
    msg.onclick = () => { msg.onclick = null; stopCamera(); startRinging(); };
  }
}

function finish() {
  stopSound();
  stopCamera();
  keepAwake(false);
  state.ringing = false;
  save(state);
  $('doneCount').textContent = state.reps;
  show('done');
}

window.addEventListener('beforeunload', (e) => {
  if (state.ringing) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- buttons ----------
function readForm() {
  state.time = $('alarmTime').value || '07:00';
  state.reps = Math.max(1, Math.min(100, parseInt($('repTarget').value, 10) || 10));
  $('repTarget').value = state.reps;
}

$('setBtn').addEventListener('click', async () => {
  unlockAudio();
  readForm();
  state.nextFire = nextOccurrence(state.time);
  save(state);
  keepAwake(true);
  renderSetup();
  // Ask for camera permission now, so you're not fumbling with a prompt half-asleep.
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {
    $('status').textContent += ' ⚠️ Camera access was denied. You’ll need it to turn the alarm off.';
  }
  loadLandmarker().catch(() => {}); // preload the model in the background
});

$('cancelBtn').addEventListener('click', () => {
  state.nextFire = null;
  save(state);
  keepAwake(false);
  renderSetup();
});

$('testBtn').addEventListener('click', () => {
  unlockAudio();
  readForm();
  save(state);
  startRinging();
});

$('backBtn').addEventListener('click', () => {
  show('setup');
  renderSetup();
});

// ---------- startup ----------
if (state.ringing) {
  // Page was reloaded mid-alarm. Keep ringing (sound needs a tap to resume).
  startRinging();
  document.addEventListener('pointerdown', unlockAudio, { once: true });
} else {
  show('setup');
  renderSetup();
  if (state.nextFire) keepAwake(true);
}
setInterval(() => { if (!state.ringing && screens.setup.offsetParent) renderSetup(); }, 30000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
