const express = require('express');
const { createTask, getTask, getAllTasks } = require('../store');

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

module.exports = router;
