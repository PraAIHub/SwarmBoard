const express = require('express');
const { createTask, getTask, getAllTasks, updateTask, deleteTask } = require('../store');

const router = express.Router();

// POST /api/tasks — Create a new task
router.post('/', (req, res) => {
  const { title, description, priority, category, dueDate } = req.body;

  if (!title || typeof title !== 'string' || title.trim().length === 0 || title.trim().length > 200) {
    return res.status(400).json({ error: 'title is required and must be a string between 1 and 200 characters' });
  }

  const task = createTask({
    title: title.trim(),
    description,
    priority,
    category,
    dueDate,
  });

  res.status(201).json({ task });
});

// GET /api/tasks — List all tasks
router.get('/', (req, res) => {
  const tasks = getAllTasks();
  res.json({ tasks, count: tasks.length });
});

// GET /api/tasks/:id — Get a single task
router.get('/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json({ task });
});

const VALID_STATUSES = ['todo', 'in-progress', 'done'];
const VALID_PRIORITIES = ['low', 'medium', 'high'];

// PUT /api/tasks/:id — Update an existing task
router.put('/:id', (req, res) => {
  const { title, description, status, priority, category, dueDate } = req.body;

  // At least one field must be provided
  const fields = { title, description, status, priority, category, dueDate };
  const hasUpdate = Object.values(fields).some(v => v !== undefined);
  if (!hasUpdate) {
    return res.status(400).json({ error: 'At least one field must be provided to update' });
  }

  // Validate title if provided
  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length === 0 || title.trim().length > 200) {
      return res.status(400).json({ error: 'title must be a string between 1 and 200 characters' });
    }
  }

  // Validate status if provided
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  // Validate priority if provided
  if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` });
  }

  // Build updates object with only provided fields
  const updates = {};
  if (title !== undefined) updates.title = title.trim();
  if (description !== undefined) updates.description = description;
  if (status !== undefined) updates.status = status;
  if (priority !== undefined) updates.priority = priority;
  if (category !== undefined) updates.category = category;
  if (dueDate !== undefined) updates.dueDate = dueDate;

  const task = updateTask(req.params.id, updates);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  res.json({ task });
});

// DELETE /api/tasks/:id — Delete a task
router.delete('/:id', (req, res) => {
  const deleted = deleteTask(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.status(204).send();
});

module.exports = router;
