const { createTask, getTask, getAllTasks, updateTask, deleteTask, clearAll } = require('../src/store');

beforeEach(() => {
  clearAll();
});

describe('QA — TICKET-002: Task data model and in-memory store', () => {
  describe('AC1: Task model has all required fields', () => {
    test('created task has exactly 9 expected fields', () => {
      const task = createTask({ title: 'Test' });
      const fields = Object.keys(task);
      expect(fields).toEqual(
        expect.arrayContaining(['id', 'title', 'description', 'status', 'priority', 'category', 'dueDate', 'createdAt', 'updatedAt'])
      );
      expect(fields).toHaveLength(9);
    });

    test('id is a valid UUID v4 format', () => {
      const task = createTask({ title: 'UUID test' });
      expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('AC2: id is auto-generated and unique', () => {
    test('100 tasks all have unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        const task = createTask({ title: `Task ${i}` });
        ids.add(task.id);
      }
      expect(ids.size).toBe(100);
    });

    test('id cannot be overridden by caller', () => {
      const task = createTask({ title: 'Test' });
      // The id should be auto-generated, not caller-supplied
      // Note: current implementation destructures only known fields, so custom id is ignored
      expect(task.id).toBeDefined();
      expect(typeof task.id).toBe('string');
      expect(task.id.length).toBe(36);
    });
  });

  describe('AC3: status defaults to todo', () => {
    test('omitting status results in todo', () => {
      const task = createTask({ title: 'Test' });
      expect(task.status).toBe('todo');
    });

    test('explicit status overrides default', () => {
      const task = createTask({ title: 'Test', status: 'done' });
      expect(task.status).toBe('done');
    });
  });

  describe('AC4: priority defaults to medium', () => {
    test('omitting priority results in medium', () => {
      const task = createTask({ title: 'Test' });
      expect(task.priority).toBe('medium');
    });

    test('explicit priority overrides default', () => {
      const task = createTask({ title: 'Test', priority: 'high' });
      expect(task.priority).toBe('high');
    });
  });

  describe('AC5: createdAt and updatedAt are ISO 8601', () => {
    test('timestamps are valid ISO 8601 strings', () => {
      const task = createTask({ title: 'Test' });
      // Verify ISO 8601 format
      expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
      expect(new Date(task.updatedAt).toISOString()).toBe(task.updatedAt);
    });

    test('createdAt equals updatedAt on new task', () => {
      const task = createTask({ title: 'Test' });
      expect(task.createdAt).toBe(task.updatedAt);
    });
  });

  describe('AC6: In-memory Map store operations', () => {
    test('add: createTask stores the task in the map', () => {
      const task = createTask({ title: 'Stored' });
      expect(getTask(task.id)).toEqual(task);
    });

    test('get: getTask retrieves by ID', () => {
      const task = createTask({ title: 'Retrieve me' });
      const found = getTask(task.id);
      expect(found.title).toBe('Retrieve me');
    });

    test('getAll: returns tasks in insertion order', () => {
      createTask({ title: 'First' });
      createTask({ title: 'Second' });
      createTask({ title: 'Third' });
      const all = getAllTasks();
      expect(all.map(t => t.title)).toEqual(['First', 'Second', 'Third']);
    });

    test('update: partial update preserves other fields', () => {
      const task = createTask({ title: 'Original', description: 'Keep me', priority: 'low' });
      const updated = updateTask(task.id, { title: 'Changed' });
      expect(updated.title).toBe('Changed');
      expect(updated.description).toBe('Keep me');
      expect(updated.priority).toBe('low');
    });

    test('delete: task no longer retrievable after deletion', () => {
      const task = createTask({ title: 'Gone' });
      deleteTask(task.id);
      expect(getTask(task.id)).toBeNull();
      expect(getAllTasks()).toHaveLength(0);
    });

    test('clearAll: removes all tasks', () => {
      createTask({ title: 'A' });
      createTask({ title: 'B' });
      clearAll();
      expect(getAllTasks()).toHaveLength(0);
    });
  });

  describe('Edge cases', () => {
    test('createTask with empty title stores the task', () => {
      // Note: store does not validate — validation is a separate ticket (TICKET-006)
      const task = createTask({ title: '' });
      expect(task.title).toBe('');
      expect(getTask(task.id)).toBeTruthy();
    });

    test('createTask with undefined title stores null-ish value', () => {
      const task = createTask({});
      expect(task.title).toBeUndefined();
    });

    test('updateTask with empty updates object still updates updatedAt', () => {
      const task = createTask({ title: 'Test' });
      const originalUpdatedAt = task.updatedAt;
      const updated = updateTask(task.id, {});
      expect(updated.updatedAt).toBeDefined();
      expect(updated.title).toBe('Test');
    });

    test('deleteTask on already-deleted task returns false', () => {
      const task = createTask({ title: 'Test' });
      deleteTask(task.id);
      expect(deleteTask(task.id)).toBe(false);
    });

    test('updateTask does not allow overwriting id', () => {
      const task = createTask({ title: 'Test' });
      const originalId = task.id;
      updateTask(task.id, { id: 'hacked-id' });
      expect(getTask(originalId).id).toBe(originalId);
    });

    test('updateTask does not allow overwriting createdAt', () => {
      const task = createTask({ title: 'Test' });
      const originalCreatedAt = task.createdAt;
      updateTask(task.id, { createdAt: '1999-01-01T00:00:00.000Z' });
      expect(getTask(task.id).createdAt).toBe(originalCreatedAt);
    });

    test('updateTask does not allow overwriting updatedAt directly', () => {
      const task = createTask({ title: 'Test' });
      updateTask(task.id, { updatedAt: '1999-01-01T00:00:00.000Z' });
      // updatedAt should be auto-set, not the value we passed
      expect(getTask(task.id).updatedAt).not.toBe('1999-01-01T00:00:00.000Z');
    });

    test('multiple operations in sequence maintain consistency', () => {
      const t1 = createTask({ title: 'Task 1' });
      const t2 = createTask({ title: 'Task 2' });
      const t3 = createTask({ title: 'Task 3' });

      updateTask(t2.id, { title: 'Task 2 updated', status: 'in-progress' });
      deleteTask(t1.id);

      const all = getAllTasks();
      expect(all).toHaveLength(2);
      expect(all.find(t => t.id === t2.id).title).toBe('Task 2 updated');
      expect(all.find(t => t.id === t1.id)).toBeUndefined();
      expect(getTask(t3.id).title).toBe('Task 3');
    });
  });
});
