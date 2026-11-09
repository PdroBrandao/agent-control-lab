export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  advance?(ms: number): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Test clock. Sleep records the requested delay and advances immediately. */
export class ManualClock implements Clock {
  private current: number;
  readonly sleeps: number[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }
}
