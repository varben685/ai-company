// Deterministic fixture used only by the offline DEMO Developer.
export const demoTodoImplementation = `let nextId = 1;
const todos = [];

function copy(todo) { return { ...todo }; }

export function createTodo(title) {
  if (typeof title !== "string" || !title.trim()) throw new Error("TITLE_REQUIRED");
  const todo = { id: nextId++, title: title.trim(), completed: false };
  todos.push(todo);
  return copy(todo);
}

export function listTodos(options = {}) {
  return todos.filter((todo) => options.includeCompleted !== false || !todo.completed).map(copy);
}

export function setCompleted(id, completed) {
  if (typeof completed !== "boolean") throw new Error("COMPLETED_REQUIRED");
  const todo = todos.find((item) => item.id === id);
  if (!todo) throw new Error("TODO_NOT_FOUND");
  todo.completed = completed;
  return copy(todo);
}
`;
