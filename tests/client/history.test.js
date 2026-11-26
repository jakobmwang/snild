import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByDate } from "../../web/js/core/history.js";

const at = (date) => ({ id: date, title: date, updated_at: new Date(date).getTime() / 1000 });

test("chats are grouped by the reader's calendar days, newest first", () => {
  const now = new Date("2026-11-26T10:00:00");
  const groups = groupByDate([at("2026-11-26T00:30:00"), at("2026-11-25T23:59:00"), at("2026-11-20T12:00:00"),
    at("2026-11-19T12:00:00"), at("2026-11-26T09:00:00"), at("2025-01-01T12:00:00")], now);
  assert.deepEqual(groups.map((g) => [g.period, g.chats.map((c) => c.id)]), [
    ["today", ["2026-11-26T09:00:00", "2026-11-26T00:30:00"]],
    ["yesterday", ["2026-11-25T23:59:00"]],
    ["week", ["2026-11-20T12:00:00", "2026-11-19T12:00:00"]],
    ["older", ["2025-01-01T12:00:00"]],
  ]);
});

test("empty groups are left out", () => {
  assert.deepEqual(groupByDate([], new Date()), []);
  assert.deepEqual(groupByDate([at("2026-11-26T08:00:00")], new Date("2026-11-26T10:00:00")).map((g) => g.period), ["today"]);
});
