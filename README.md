# Push-Up Alarm

An alarm clock that won't shut up until you do your push-ups. When it goes off, it opens your camera and uses on-device pose detection ([MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)) to count real push-ups. The only way to stop it is to hit your target (10 by default).

## Run it

It's a plain web app with no build step. Browsers only allow the camera on `https://` or `localhost`, so:

```bash
npm start            # serves on http://localhost:8080
```

To use it on your phone, host it somewhere with HTTPS, such as GitHub Pages (Settings → Pages → deploy from this branch). Open it on your phone and use "Add to Home Screen".

## Using it

1. Pick a wake-up time and how many push-ups, then tap **Set alarm**. It asks for camera permission now, so you aren't dealing with a prompt half-asleep.
2. **Leave the page open, with the phone plugged in.** The app keeps the screen awake.
3. When it rings, put the phone on the floor about 1.5–2 m away, **side-on to you**, so it can see your whole body.
4. Do your push-ups. The skeleton overlay turns green at the top of a rep and yellow at the bottom.

**Test it now** fires the alarm immediately so you can try it.

## How reps are counted (`pushup.js`)

- It tracks the elbow angle (shoulder → elbow → wrist) on whichever arm the camera sees best.
- A rep means: arms straight (>150°), then bent past 100°, then straight again.
- Your torso (shoulder → hip) must be roughly horizontal, so bending your arms while standing or lying in bed doesn't count.
- Reps faster than 0.5 s are ignored (filters out jitter).

The thresholds are at the top of `pushup.js` if it's too strict or too lenient.

## Limitations

This is a web app, so:
- The page has to stay open in the foreground. Phones suspend background tabs, so an alarm set and then switched away from may not ring on time. (It still rings as soon as you come back to the page.)
- iPhone silent mode can mute web audio.
- Someone determined can close the tab. A native app (e.g. React Native + Android's AlarmManager, or iOS's AlarmKit) would fix all of these and could reuse the same rep-counting logic.

## Tests

```bash
npm test
```
