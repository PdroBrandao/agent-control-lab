export interface LogEvent {
  ts: number;
  execution_id: string;
  event: string;
  [field: string]: string | number | boolean | null;
}

export interface Logger {
  log(event: LogEvent): void;
}

export function createConsoleLogger(clock: { now(): number } = { now: () => Date.now() }): Logger {
  return {
    log(event) {
      console.error(JSON.stringify({ ...event, ts: event.ts ?? clock.now() }));
    },
  };
}

export interface MemoryLogger extends Logger {
  events: LogEvent[];
}

export function createMemoryLogger(): MemoryLogger {
  const events: LogEvent[] = [];
  return {
    events,
    log(event) {
      events.push(event);
    },
  };
}
