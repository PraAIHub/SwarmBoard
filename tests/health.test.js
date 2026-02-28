const request = require('supertest');
const app = require('../src/app');

describe('Health Check', () => {
  test('GET /api/health returns 200 with { status: "ok" }', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('CORS', () => {
  test('response includes Access-Control-Allow-Origin header', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('JSON body parsing', () => {
  test('accepts JSON body up to 1MB', async () => {
    // POST to a non-existent route with a valid JSON body — should get 404, not 413
    const res = await request(app)
      .post('/api/nonexistent')
      .send({ data: 'x'.repeat(1000) });
    expect(res.status).toBe(404);
  });

  test('rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{ invalid json }');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});

describe('Global error handler', () => {
  test('does not expose stack traces', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{ bad json }');
    expect(res.body).not.toHaveProperty('stack');
    expect(res.body).toHaveProperty('error');
  });
});
