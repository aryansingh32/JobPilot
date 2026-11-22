import { afterEach, expect, it, vi } from 'vitest';
import { latestFramePublisher } from '../../packages/execution-service/frame-throttle.js';
afterEach(() => vi.useRealTimers());
it('coalesces a 60-frame burst and retains the final screen', () => {
  vi.useFakeTimers(); const publish = vi.fn(); const stream = latestFramePublisher(publish);
  for (let i = 0; i < 60; i++) stream.push(i);
  vi.advanceTimersByTime(100);
  expect(publish).toHaveBeenCalledTimes(1); expect(publish).toHaveBeenLastCalledWith(59);
});
it('stops publishing when the recording closes', () => {
  vi.useFakeTimers(); const publish = vi.fn(); const stream = latestFramePublisher(publish);
  stream.push(1); stream.dispose(); vi.runAllTimers(); expect(publish).not.toHaveBeenCalled();
});
