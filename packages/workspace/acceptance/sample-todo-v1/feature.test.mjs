import test from "node:test";
import assert from "node:assert/strict";
import { createTodo, listTodos, setCompleted } from "/workspace/src/todo.js";

test("completion is idempotent and can be reversed", () => {
  const a = createTodo("acceptance one");
  assert.equal(setCompleted(a.id, true).completed, true);
  assert.equal(setCompleted(a.id, true).completed, true);
  assert.equal(setCompleted(a.id, false).completed, false);
  assert.equal(setCompleted(a.id, false).completed, false);
});

test("completed items are optionally filtered and default list includes all", () => {
  const a = createTodo("acceptance two");
  const b = createTodo("acceptance three");
  setCompleted(a.id, true);
  assert.equal(
    listTodos().some((x) => x.id === a.id),
    true,
  );
  assert.equal(
    listTodos({ includeCompleted: false }).some((x) => x.id === a.id),
    false,
  );
  assert.equal(
    listTodos({ includeCompleted: false }).some((x) => x.id === b.id),
    true,
  );
});

test("unknown ID fails and returned objects cannot mutate state", () => {
  assert.throws(() => setCompleted(999999, true), /NOT_FOUND/);
  const a = createTodo("acceptance four");
  a.title = "mutated";
  a.completed = true;
  const listed = listTodos().find((x) => x.id === a.id);
  assert.equal(listed.title, "acceptance four");
  assert.equal(listed.completed, false);
  listed.title = "mutated again";
  assert.equal(listTodos().find((x) => x.id === a.id).title, "acceptance four");
});
