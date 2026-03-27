import { clamp } from "@/lib/math";

const IMPULSE_GAIN = 4;
const IMPULSE_DECAY = 14;

export function nextGestureImpulse(previousImpulse: number, currentValue: number, previousValue: number, elapsedSeconds: number) {
  const increase = Math.max(0, currentValue - previousValue);
  const impulseInput = clamp(increase * IMPULSE_GAIN, 0, 1);
  const decay = Math.exp(-elapsedSeconds * IMPULSE_DECAY);

  return Math.max(impulseInput, previousImpulse * decay);
}
