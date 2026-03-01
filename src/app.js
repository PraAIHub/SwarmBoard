const express = require('express');
const cors = require('cors');
const tasksRouter = require('./routes/tasks');

const app = express();

// CORS enabled for all origins
app.use(cors());

// JSON body parsing with 1MB limit
app.use(express.json({ limit: '1mb' }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Task endpoints
app.use('/api/tasks', tasksRouter);

// 404 handler for unknown routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler — returns JSON errors without stack traces
app.use((err, req, res, next) => {
  // Handle JSON parse errors from body-parser
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }

  const status = err.status || 500;
  const message = status === 500 ? 'Internal server error' : err.message;
  res.status(status).json({ error: message });
});

module.exports = app;
