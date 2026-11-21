// Push-up rep counter driven by MediaPipe Pose landmarks.
//
// A rep = elbows go from straight (top of push-up) to bent past ~90°
// (bottom) and back to straight, while the torso is roughly horizontal.
// The horizontal check stops you from "cheating" by bending your arms
// while standing or sitting up in bed.

export const LM = {
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
};

const DEFAULTS = {
  upAngle: 150,        // elbow angle (deg) counted as arms straight
  downAngle: 100,      // elbow angle (deg) counted as the bottom of the rep
  maxTorsoTilt: 40,    // max degrees the shoulder→hip line may tilt from horizontal
  minVisibility: 0.5,  // landmark confidence needed to trust a frame
  minRepMs: 500,       // ignore reps faster than this (jitter guard)
  smoothing: 0.4,      // EMA factor for the elbow angle (0 = none, closer to 1 = more)
};

// Angle ABC in degrees, in pixel space (so pass the frame aspect ratio).
export function angleAt(a, b, c, aspect = 1) {
  const abx = (a.x - b.x) * aspect, aby = a.y - b.y;
  const cbx = (c.x - b.x) * aspect, cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (!mag) return 180;
  return (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180) / Math.PI;
}

// Tilt of the line p→q from horizontal, 0..90 degrees.
export function tiltFromHorizontal(p, q, aspect = 1) {
  const dx = Math.abs((q.x - p.x) * aspect);
  const dy = Math.abs(q.y - p.y);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

export class PushUpCounter {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.count = 0;
    this.phase = 'waiting'; // waiting -> up -> down -> up ...
    this.angle = null;
    this.lastRepAt = -Infinity;
    this.wentDownHorizontal = false;
  }

  // Choose the arm the camera sees best (people are usually side-on).
  _pickSide(lm) {
    const sides = [
      [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST, LM.L_HIP],
      [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST, LM.R_HIP],
    ];
    let best = null, bestVis = -1;
    for (const idx of sides) {
      const vis = Math.min(...idx.map((i) => lm[i]?.visibility ?? 0));
      if (vis > bestVis) { bestVis = vis; best = idx; }
    }
    return { idx: best, vis: bestVis };
  }

  /**
   * Feed one frame of landmarks.
   * @param {Array<{x,y,visibility}>|null} lm  normalized landmarks, or null if no person
   * @param {number} now  timestamp in ms
   * @param {number} aspect  frame width / height
   * @returns {{count:number, phase:string, angle:number|null, tilt:number|null, repCounted:boolean, message:string}}
   */
  update(lm, now, aspect = 1) {
    const out = (message, extra = {}) => ({
      count: this.count, phase: this.phase, angle: this.angle,
      tilt: null, repCounted: false, message, ...extra,
    });

    if (!lm) return out('No one in view. Get your whole body in the frame.');

    const { idx, vis } = this._pickSide(lm);
    if (vis < this.o.minVisibility) {
      return out('Can’t see your arm clearly. Turn side-on to the camera.');
    }
    const [s, e, w, h] = idx.map((i) => lm[i]);

    const raw = angleAt(s, e, w, aspect);
    this.angle = this.angle == null
      ? raw
      : this.o.smoothing * this.angle + (1 - this.o.smoothing) * raw;
    const tilt = tiltFromHorizontal(s, h, aspect);
    const horizontal = tilt <= this.o.maxTorsoTilt;
    const a = this.angle;
    let repCounted = false;
    let message;

    switch (this.phase) {
      case 'waiting':
        if (horizontal && a >= this.o.upAngle) {
          this.phase = 'up';
          message = 'Good plank. Go down!';
        } else if (!horizontal) {
          message = 'Get into push-up position (body horizontal).';
        } else {
          message = 'Straighten your arms to start.';
        }
        break;
      case 'up':
        if (a <= this.o.downAngle) {
          this.phase = 'down';
          this.wentDownHorizontal = horizontal;
          message = horizontal ? 'Now push up!' : 'Keep your body horizontal.';
        } else {
          message = horizontal ? 'Go down…' : 'Keep your body horizontal.';
        }
        break;
      case 'down':
        if (horizontal) this.wentDownHorizontal = true;
        if (a >= this.o.upAngle) {
          this.phase = 'up';
          if (this.wentDownHorizontal && now - this.lastRepAt >= this.o.minRepMs) {
            this.count++;
            this.lastRepAt = now;
            repCounted = true;
            message = 'Nice!';
          } else {
            message = this.wentDownHorizontal ? 'Too fast. Slow down.' : 'Didn’t count. Keep your body horizontal.';
          }
          this.wentDownHorizontal = false;
        } else {
          message = 'Push up!';
        }
        break;
    }

    return { count: this.count, phase: this.phase, angle: a, tilt, repCounted, message };
  }
}
