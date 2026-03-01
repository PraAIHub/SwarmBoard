const request = require('supertest');
const app = require('../src/app');
const { clearAll } = require('../src/store');

beforeEach(() => {
  clearAll();
});

describe('POST /api/tasks', () => {
  test('creates a new task and returns 201 with { task }', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'My new task', description: 'Some details', priority: 'high' });

    expect(res.status).toBe(201);
    expect(res.body.task).toBeDefined();
    expect(res.body.task.title).toBe('My new task');
    expect(res.body.task.description).toBe('Some details');
    expect(res.body.task.priority).toBe('high');
    expect(res.body.task.status).toBe('todo');
    expect(res.body.task.id).toBeDefined();
    expect(res.body.task.createdAt).toBeDefined();
    expect(res.body.task.updatedAt).toBeDefined();
  });

  test('creates a task with defaults when only title is provided', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Minimal task' });

    expect(res.status).toBe(201);
    expect(res.body.task.priority).toBe('medium');
    expect(res.body.task.status).toBe('todo');
    expect(res.body.task.description).toBeNull();
    expect(res.body.task.category).toBeNull();
    expect(res.body.task.dueDate).toBeNull();
  });

  test('returns 400 when title is missing', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ description: 'No title here' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error).toMatch(/title/i);
  });

  test('returns 400 when title is empty string', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('returns 400 when title exceeds 200 characters', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'a'.repeat(201) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('returns 400 when title is not a string', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('GET /api/tasks', () => {
  test('returns 200 with empty list when no tasks exist', async () => {
    const res = await request(app).get('/api/tasks');

    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  test('returns all tasks with correct count', async () => {
    await request(app).post('/api/tasks').send({ title: 'Task 1' });
    await request(app).post('/api/tasks').send({ title: 'Task 2' });
    await request(app).post('/api/tasks').send({ title: 'Task 3' });

    const res = await request(app).get('/api/tasks');

    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(3);
    expect(res.body.count).toBe(3);
  });
});

describe('GET /api/tasks/:id', () => {
  test('returns 200 with task for existing id', async () => {
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'Find me' });
    const taskId = createRes.body.task.id;

    const res = await request(app).get(`/api/tasks/${taskId}`);

    expect(res.status).toBe(200);
    expect(res.body.task).toBeDefined();
    expect(res.body.task.id).toBe(taskId);
    expect(res.body.task.title).toBe('Find me');
  });

  test('returns 404 with error for non-existent id', async () => {
    const res = await request(app).get('/api/tasks/nonexistent-id-12345');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
  });
});
