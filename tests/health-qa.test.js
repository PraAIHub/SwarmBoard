const request = require('supertest');
const app = require('../src/app');

describe('QA — TICKET-001: Express Server Scaffold', () => {

  describe('AC1: Health endpoint', () => {
    test('GET /api/health returns 200', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    test('GET /api/health returns JSON content-type', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('AC2: CORS enabled for all origins', () => {
    test('responds to CORS preflight (OPTIONS) request', async () => {
      const res = await request(app)
        .options('/api/health')
        .set('Origin', 'http://example.com')
        .set('Access-Control-Request-Method', 'GET');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    test('CORS header present on regular GET', async () => {
      const res = await request(app)
        .get('/api/health')
        .set('Origin', 'http://random-origin.com');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('AC3: JSON body parsing with 1MB limit', () => {
    test('rejects body larger than 1MB with 413', async () => {
      const largeBody = JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 1) });
      const res = await request(app)
        .post('/api/health')
        .set('Content-Type', 'application/json')
        .send(largeBody);
      expect(res.status).toBe(413);
    });

    test('accepts body just under 1MB', async () => {
      // ~500KB is well under 1MB
      const res = await request(app)
        .post('/api/nonexistent')
        .send({ data: 'x'.repeat(500 * 1024) });
      // Should not be 413 — will be 404 since route doesn't exist
      expect(res.status).not.toBe(413);
    });
  });

  describe('AC4: Global error handler — JSON errors, no stack traces', () => {
    test('malformed JSON returns 400 with error message', async () => {
      const res = await request(app)
        .post('/api/health')
        .set('Content-Type', 'application/json')
        .send('not valid json');
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toBe('Invalid JSON in request body');
    });

    test('error response has no stack property', async () => {
      const res = await request(app)
        .post('/api/health')
        .set('Content-Type', 'application/json')
        .send('{ broken }');
      expect(res.body).not.toHaveProperty('stack');
    });

    test('unknown routes return 404 (not 500)', async () => {
      const res = await request(app).get('/api/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('AC5: Package dependencies', () => {
    test('package.json has express dependency', () => {
      const pkg = require('../package.json');
      expect(pkg.dependencies).toHaveProperty('express');
    });

    test('package.json has cors dependency', () => {
      const pkg = require('../package.json');
      expect(pkg.dependencies).toHaveProperty('cors');
    });
  });

  describe('Edge cases', () => {
    test('GET /api/health with query params still works', async () => {
      const res = await request(app).get('/api/health?foo=bar');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    test('POST to /api/health with valid JSON does not crash', async () => {
      const res = await request(app)
        .post('/api/health')
        .send({ test: true });
      // Health is GET-only, so this should be 404
      expect([404, 200]).toContain(res.status);
    });

    test('empty body POST does not crash', async () => {
      const res = await request(app)
        .post('/api/nonexistent')
        .set('Content-Type', 'application/json')
        .send('');
      // Should not be 500
      expect(res.status).not.toBe(500);
    });
  });
});
