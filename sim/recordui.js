// ---------- stop-recording button ----------
// Shown only while frames are actually landing, hidden the rest of the
// time. It exists because recording no longer ends when you lift off:
// a session deliberately runs through braking and stops, since waiting at
// a red light is the behaviour the city world is there to teach. That
// leaves no way to end a take on purpose except waiting out the idle
// timeout, which is exactly wrong when you are sitting at a signal and
// have decided you're done.
//
// The visibility is driven from the render loop rather than from a
// subscription, because "is recording" is a per-frame product of mode,
// session, and off-track state that isn't owned by any one module.

const btn = document.getElementById('stopRecBtn');

let onStop = () => {};
export function onStopRecording(fn) { onStop = fn; }

btn.addEventListener('click', () => {
  onStop();
  // Hide immediately rather than waiting for the next frame's sync: the
  // click has already ended the take, and a button that lingers reads as
  // one that didn't work.
  btn.classList.remove('on');
});

export function drawRecordButton(isRecording) {
  btn.classList.toggle('on', isRecording);
}
