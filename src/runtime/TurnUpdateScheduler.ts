export class TurnUpdateScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;

  constructor(
    private readonly publish: () => void,
    private readonly intervalMs = 100,
  ) {}

  schedule(): void {
    this.pending = true;
    if (this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.pending) {
        return;
      }
      this.pending = false;
      this.publish();
    }, this.intervalMs);
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = false;
    this.publish();
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = false;
  }
}
