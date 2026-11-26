// @ts-check

/** The stream ended in the middle of a line: the connection was cut. */
export class TruncatedStream extends Error {
  constructor() {
    super("The stream ended in the middle of a line.");
    this.name = "TruncatedStream";
  }
}

/**
 * Read a byte stream of newline-delimited JSON and yield one parsed value per line.
 * Lines may arrive split across chunks, and a multi-byte character may be split between chunks.
 * Every line ends with a newline, so text left over at the end means the stream was cut (TruncatedStream).
 * If the consumer stops early, the underlying stream is cancelled.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<unknown, void, undefined>}
 */
export async function* readNdjson(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) throw new TruncatedStream();
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
