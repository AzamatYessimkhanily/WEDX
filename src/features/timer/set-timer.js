// Deadlines keep time accurate after backgrounding; intervals only repaint the UI.
export function remainingSeconds(timer, now = Date.now()) {
  return Math.max(0, timer.endAt === null ? timer.remaining : (timer.endAt - now) / 1000);
}
export function elapsedSeconds(timer, now = Date.now()) {
  return Math.min(timer.total, Math.max(0, Math.floor(timer.total - remainingSeconds(timer, now))));
}
export function pauseSetTimer(timer, now = Date.now()) {
  return { ...timer, remaining: remainingSeconds(timer, now), endAt: null };
}
export function resumeSetTimer(timer, now = Date.now()) {
  return { ...timer, endAt: now + timer.remaining * 1000 };
}
