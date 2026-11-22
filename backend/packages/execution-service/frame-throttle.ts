/** Bound stream traffic and retain the final frame of each burst. */
export function latestFramePublisher<T>(publish: (frame: T) => void, intervalMs = 100) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: T | undefined;
  return {
    push(frame: T) {
      latest = frame;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const frame = latest;
        latest = undefined;
        if (frame !== undefined) publish(frame);
      }, intervalMs);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
      latest = undefined;
    },
  };
}
