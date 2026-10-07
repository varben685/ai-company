import test from "node:test";
import assert from "node:assert/strict";
import { createTodo, listTodos } from "../src/todo.js";

test("create and list todos without exposing stored objects", () => {
  const first = createTodo("Read spec");
  assert.equal(first.title, "Read spec");
  first.title = "changed";
  const all = listTodos();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, "Read spec");
});
