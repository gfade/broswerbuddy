/**
 * Collects string chunks and delivers them in batches at most every `ms` milliseconds,
 * so a token-by-token stream does not flood the event bus. `flush()` delivers any
 * pending text immediately; `cancel()` drops it.
 */
export class Batcher {
  private buf = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deliver: (text: string) => void,
    private readonly ms = 150,
  ) {}

  push(text: string): void {
    if (!text) return;
    this.buf += text;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.ms);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.buf) return;
    const text = this.buf;
    this.buf = '';
    try {
      this.deliver(text);
    } catch {
      /* delivery is best effort; never let a listener break the pipeline */
    }
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.buf = '';
  }
}

/** Line-oriented variant: pushes complete lines only, flushes the trailing partial line on flush(). */
export class LineBatcher {
  private partial = '';
  private readonly inner: Batcher;

  constructor(deliverLine: (line: string) => void, ms = 150) {
    this.inner = new Batcher((text) => {
      for (const line of text.split('\n')) {
        if (line.trim()) deliverLine(line.replace(/\r$/, ''));
      }
    }, ms);
  }

  push(chunk: string): void {
    const combined = this.partial + chunk;
    const lines = combined.split('\n');
    this.partial = lines.pop() ?? '';
    if (lines.length) this.inner.push(lines.join('\n') + '\n');
  }

  flush(): void {
    if (this.partial) {
      this.inner.push(this.partial);
      this.partial = '';
    }
    this.inner.flush();
  }

  cancel(): void {
    this.partial = '';
    this.inner.cancel();
  }
}
