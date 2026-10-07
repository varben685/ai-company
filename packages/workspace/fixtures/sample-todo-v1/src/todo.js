let nextId = 1;
const todos = [];

export function createTodo(title) {
  if (typeof title !== "string" || !title.trim())
    throw new Error("TITLE_REQUIRED");
  const todo = { id: nextId++, title: title.trim() };
  todos.push(todo);
  return { ...todo };
}

export function listTodos() {
  return todos.map((todo) => ({ ...todo }));
}
