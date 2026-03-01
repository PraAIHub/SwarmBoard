const { randomUUID } = require('crypto');

const tasks = new Map();

function createTask({ title, description, status, priority, category, dueDate }) {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    title,
    description: description || null,
    status: status || 'todo',
    priority: priority || 'medium',
    category: category || null,
    dueDate: dueDate || null,
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(task.id, task);
  return task;
}

function getTask(id) {
  return tasks.get(id) || null;
}

function getAllTasks() {
  return Array.from(tasks.values());
}

function updateTask(id, updates) {
  const task = tasks.get(id);
  if (!task) return null;

  const allowed = ['title', 'description', 'status', 'priority', 'category', 'dueDate'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      task[key] = updates[key];
    }
  }
  task.updatedAt = new Date().toISOString();
  tasks.set(id, task);
  return task;
}

function deleteTask(id) {
  if (!tasks.has(id)) return false;
  tasks.delete(id);
  return true;
}

function clearAll() {
  tasks.clear();
}

module.exports = { createTask, getTask, getAllTasks, updateTask, deleteTask, clearAll };
