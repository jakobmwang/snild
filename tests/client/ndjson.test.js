import { test } from "node:test";
import assert from "node:assert/strict";
import { readNdjson, TruncatedStream } from "../../web/js/core/ndjson.js";

/** A byte stream that delivers the given chunks one by one. */
function streamOf(...chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function collect(stream) {
  const out = [];
  for await (const value of readNdjson(stream)) out.push(value);
  return out;
}

test("one value per line", async () => {
  assert.deepEqual(await collect(streamOf('{"a":1}\n{"b":2}\n')), [{ a: 1 }, { b: 2 }]);
});

test("lines split across chunks are joined", async () => {
  assert.deepEqual(await collect(streamOf('{"te', 'xt":"he', 'llo"}\n{"n"', ":2}\n")), [{ text: "hello" }, { n: 2 }]);
});

test("a multi-byte character split between chunks survives", async () => {
  const bytes = new TextEncoder().encode('{"t":"æøå 🦆"}\n');
  const cut = bytes.indexOf(0xf0) + 2; // inside the four bytes of the duck
  assert.deepEqual(await collect(streamOf(bytes.slice(0, 5), bytes.slice(5, cut), bytes.slice(cut))), [{ t: "æøå 🦆" }]);
});

test("blank lines are ignored", async () => {
  assert.deepEqual(await collect(streamOf('\n{"a":1}\n\n', '{"b":2}\n')), [{ a: 1 }, { b: 2 }]);
});

test("text left after the last newline means the stream was cut", async () => {
  const seen = [];
  await assert.rejects(async () => {
    for await (const value of readNdjson(streamOf('{"a":1}\n{"b":2'))) seen.push(value);
  }, TruncatedStream);
  assert.deepEqual(seen, [{ a: 1 }]);
});

test("a broken line is an error, not silently skipped", async () => {
  await assert.rejects(collect(streamOf('{"a":1}\n{"b":\n')), SyntaxError);
});

test("stopping early cancels the stream", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode('{"a":1}\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const value of readNdjson(stream)) {
    assert.deepEqual(value, { a: 1 });
    break;
  }
  assert.equal(cancelled, true);
});
