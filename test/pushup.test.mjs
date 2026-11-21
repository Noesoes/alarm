// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PushUpCounter, angleAt } from '../pushup.js';

// Build a fake side-on pose. elbowDeg = elbow angle, torsoTilt = degrees from horizontal.
function pose(elbowDeg, torsoTilt = 5, vis = 0.9) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.1 }));
  const shoulder = { x: 0.3, y: 0.5 };
  const t = (torsoTilt * Math.PI) / 180;
  const hip = { x: shoulder.x + 0.3 * Math.cos(t), y: shoulder.y + 0.3 * Math.sin(t) };
  // Upper arm points straight down from the shoulder; forearm rotated by the elbow angle.
  const elbow = { x: shoulder.x, y: shoulder.y + 0.15 };
  const a = Math.PI - (elbowDeg * Math.PI) / 180; // deviation from straight
  const wrist = { x: elbow.x - 0.15 * Math.sin(a), y: elbow.y + 0.15 * Math.cos(a) };
  for (const [i, p] of [[11, shoulder], [13, elbow], [15, wrist], [23, hip]]) lm[i] = { ...p, visibility: vis };
  return lm;
}

function doReps(counter, n, { tilt = 5, start = 0, stepMs = 50 } = {}) {
  let t = start;
  const seq = [170, 150, 120, 90, 75, 90, 120, 150, 170, 175];
  for (let r = 0; r < n; r++) for (const deg of seq) counter.update(pose(deg, tilt), (t += stepMs), 1);
  return t;
}

test('pose helper produces the requested elbow angle', () => {
  const lm = pose(90);
  assert.ok(Math.abs(angleAt(lm[11], lm[13], lm[15]) - 90) < 0.5);
});

test('counts 10 proper push-ups', () => {
  const c = new PushUpCounter({ smoothing: 0 });
  doReps(c, 10);
  assert.equal(c.count, 10);
});

test('works with default smoothing', () => {
  const c = new PushUpCounter();
  doReps(c, 10);
  assert.equal(c.count, 10);
});

test('does not count arm bends while standing upright', () => {
  const c = new PushUpCounter({ smoothing: 0 });
  doReps(c, 10, { tilt: 80 });
  assert.equal(c.count, 0);
});

test('half reps (never bending past 90°) do not count', () => {
  const c = new PushUpCounter({ smoothing: 0 });
  let t = 0;
  for (let r = 0; r < 10; r++) for (const deg of [170, 140, 120, 140, 170]) c.update(pose(deg), (t += 50), 1);
  assert.equal(c.count, 0);
});

test('no person / low visibility frames are ignored safely', () => {
  const c = new PushUpCounter({ smoothing: 0 });
  assert.equal(c.update(null, 0).count, 0);
  assert.equal(c.update(pose(80, 5, 0.1), 10).count, 0);
});

test('jittery reps faster than minRepMs are rejected', () => {
  const c = new PushUpCounter({ smoothing: 0, minRepMs: 2000 });
  doReps(c, 3, { stepMs: 10 }); // each rep takes 100ms
  assert.equal(c.count, 1);
});
