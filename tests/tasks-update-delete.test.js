const request = require('supertest');
const app = require('../src/app');
const { clearAll } = require('../src/store');

beforeEach(() => {
  clearAll();
});

describe('PUT /api/tasks/:id', () => {
  let taskId;

  beforeEach(async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Original title', priority: 'low', category: 'work' });
    taskId = res.body.task.id;
  });

  test('updates the task and returns 200 with { task }', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskId}`)
      .send({ title: 'Updated title' });

    expect(res.status).toBe(200);
    expect(res.body.task).toBeDefined();
    expect(res.body.task.title).toBe('Updated title');
    expect(res.body.task.id).toBe(taskId);
  });

  test('updates multiple fields at once', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskId}`)
      .send({ title: 'New title', priority: 'high', status: 'in-progress' });

    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('New title');
    expect(res.body.task.priority).toBe('high');
    expect(res.body.task.status).toBe('in-progress');
  });

  test('returns 400 when no fields are provided', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskId}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one field/i);
  });

  test('returns 400 for invalid status value', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskId}`)
      .send({ status: 'invalid-status' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });

  test('returns 400 for invalid priority value', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskId}`)
      .send({ priority: 'urgent' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/priority/i);
  });

  test('returns 404 for non-existent task', async () => {
    const res = await request(app)
      .put('/api/tasks/nonexistent-id-12345')
      .send({ title: 'Does not matter' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
  });

  test('updates the updatedAt timestamp', async () => {
    const before = await request(app).get(`/api/tasks/${taskId}`);
    const originalUpdatedAt = before.body.task.updatedAt;

    // Small delay to ensure timestamp differs
    await new Promise(resolve => setTimeout(resolve, 10));

    const res = await request(app)
      .put(`/api/tasks/${taskId}`)
      .send({ title: 'Timestamp test' });

    expect(res.status).toBe(200);
    expect(res.body.task.updatedAt).not.toBe(originalUpdatedAt);
  });

  test('returns 400 for invalid title (empty string)', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskId}`)
      .send({ title: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });

  test('returns 400 for title exceeding 200 chars', async () => {
    const res = await request(app)
      .put(`/api/tasks/${taskId}`)
      .send({ title: 'a'.repeat(201) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });

  test('accepts all valid status values', async () => {
    for (const status of ['todo', 'in-progress', 'done']) {
      const res = await request(app)
        .put(`/api/tasks/${taskId}`)
        .send({ status });

      expect(res.status).toBe(200);
      expect(res.body.task.status).toBe(status);
    }
  });
});

describe('DELETE /api/tasks/:id', () => {
  test('deletes the task and returns 204 with no body', async () => {
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'Delete me' });
    const taskId = createRes.body.task.id;

    const res = await request(app).delete(`/api/tasks/${taskId}`);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    // Verify task is actually gone
    const getRes = await request(app).get(`/api/tasks/${taskId}`);
    expect(getRes.status).toBe(404);
  });

  test('returns 404 for non-existent task', async () => {
    const res = await request(app).delete('/api/tasks/nonexistent-id-12345');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Task not found');
  });

  test('returns 404 when deleting already deleted task', async () => {
    const createRes = await request(app)
      .post('/api/tasks')
      .send({ title: 'Double delete' });
    const taskId = createRes.body.task.id;

    await request(app).delete(`/api/tasks/${taskId}`);
    const res = await request(app).delete(`/api/tasks/${taskId}`);

    expect(res.status).toBe(404);
  });
});
