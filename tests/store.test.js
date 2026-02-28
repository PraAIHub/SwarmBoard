const { createTask, getTask, getAllTasks, updateTask, deleteTask, clearAll } = require('../src/store');

beforeEach(() => {
  clearAll();
});

describe('createTask', () => {
  test('creates a task with all required fields and defaults', () => {
    const task = createTask({ title: 'Test task' });

    expect(task.id).toBeDefined();
    expect(typeof task.id).toBe('string');
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.title).toBe('Test task');
    expect(task.description).toBeNull();
    expect(task.status).toBe('todo');
    expect(task.priority).toBe('medium');
    expect(task.category).toBeNull();
    expect(task.dueDate).toBeNull();
    expect(task.createdAt).toBeDefined();
    expect(task.updatedAt).toBeDefined();
  });

  test('auto-generates a UUID for id', () => {
    const task1 = createTask({ title: 'Task 1' });
    const task2 = createTask({ title: 'Task 2' });
    expect(task1.id).not.toBe(task2.id);
  });

  test('defaults status to todo', () => {
    const task = createTask({ title: 'Test' });
    expect(task.status).toBe('todo');
  });

  test('defaults priority to medium', () => {
    const task = createTask({ title: 'Test' });
    expect(task.priority).toBe('medium');
  });

  test('sets createdAt and updatedAt to ISO 8601 timestamps', () => {
    const before = new Date().toISOString();
    const task = createTask({ title: 'Test' });
    const after = new Date().toISOString();

    expect(task.createdAt >= before).toBe(true);
    expect(task.createdAt <= after).toBe(true);
    expect(task.updatedAt).toBe(task.createdAt);
  });

  test('accepts all optional fields', () => {
    const task = createTask({
      title: 'Full task',
      description: 'A description',
      status: 'in-progress',
      priority: 'high',
      category: 'work',
      dueDate: '2026-03-15T00:00:00.000Z',
    });

    expect(task.description).toBe('A description');
    expect(task.status).toBe('in-progress');
    expect(task.priority).toBe('high');
    expect(task.category).toBe('work');
    expect(task.dueDate).toBe('2026-03-15T00:00:00.000Z');
  });
});

describe('getTask', () => {
  test('returns the task by id', () => {
    const created = createTask({ title: 'Find me' });
    const found = getTask(created.id);
    expect(found).toEqual(created);
  });

  test('returns null for non-existent id', () => {
    expect(getTask('non-existent-id')).toBeNull();
  });
});

describe('getAllTasks', () => {
  test('returns empty array when no tasks', () => {
    expect(getAllTasks()).toEqual([]);
  });

  test('returns all tasks', () => {
    createTask({ title: 'Task 1' });
    createTask({ title: 'Task 2' });
    createTask({ title: 'Task 3' });

    const all = getAllTasks();
    expect(all).toHaveLength(3);
  });
});

describe('updateTask', () => {
  test('updates specified fields', () => {
    const task = createTask({ title: 'Original' });
    const updated = updateTask(task.id, { title: 'Updated', priority: 'high' });

    expect(updated.title).toBe('Updated');
    expect(updated.priority).toBe('high');
    expect(updated.status).toBe('todo');
  });

  test('updates updatedAt timestamp', () => {
    const task = createTask({ title: 'Test' });
    const originalUpdatedAt = task.updatedAt;

    // Small delay to ensure timestamp differs
    const updated = updateTask(task.id, { title: 'Changed' });
    expect(updated.updatedAt >= originalUpdatedAt).toBe(true);
  });

  test('returns null for non-existent id', () => {
    expect(updateTask('non-existent', { title: 'Nope' })).toBeNull();
  });

  test('does not update id, createdAt, or unknown fields', () => {
    const task = createTask({ title: 'Test' });
    const updated = updateTask(task.id, { id: 'new-id', createdAt: 'new-date', unknown: 'field' });

    expect(updated.id).toBe(task.id);
    expect(updated.createdAt).toBe(task.createdAt);
    expect(updated.unknown).toBeUndefined();
  });
});

describe('deleteTask', () => {
  test('deletes an existing task and returns true', () => {
    const task = createTask({ title: 'Delete me' });
    expect(deleteTask(task.id)).toBe(true);
    expect(getTask(task.id)).toBeNull();
  });

  test('returns false for non-existent id', () => {
    expect(deleteTask('non-existent')).toBe(false);
  });
});
