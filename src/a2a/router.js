/**
 * router.js — A2A (Agent-to-Agent) Protocol Routes.
 *
 * Implements the A2A standard endpoints:
 * - GET  /.well-known/agent.json — Agent Card discovery
 * - POST /a2a/tasks/send — Create and execute task
 * - GET  /a2a/tasks/:taskId — Get task status
 * - POST /a2a/tasks/:taskId/cancel — Cancel task
 *
 * Authentication:
 * - Bearer token in Authorization header
 * - Or X-A2A-Key header
 * - Configured via config.a2a.apiKeys array
 */

const express = require('express');
const crypto = require('crypto');
const { createLogger } = require('../shared/logger');
const { generateAgentCard } = require('./agent-card');
const { A2ATaskManager } = require('./task-manager');

const log = createLogger('a2a:router');

const router = express.Router();

// ─── State (injected during initialization) ────────────────────────
let taskManager = null;
let config = null;
let agentRuntime = null;
let agentConfig = null;

/**
 * Initialize A2A router with dependencies.
 *
 * @param {object} deps
 * @param {object} deps.config - Configuration
 * @param {A2ATaskManager} deps.taskManager - Task manager instance
 * @param {function} deps.agentRuntime - Agent runtime function
 * @param {object} deps.agentConfig - Agent configuration
 */
function initializeRouter(deps) {
  taskManager = deps.taskManager;
  config = deps.config;
  agentRuntime = deps.agentRuntime;
  agentConfig = deps.agentConfig || {};
  log.info('A2A router initialized');
}

/**
 * Authentication middleware.
 * Checks for Bearer token or X-A2A-Key header.
 */
function authenticateA2A(req, res, next) {
  const a2aConfig = config?.a2a || {};

  // If A2A is not enabled, reject the request
  if (!a2aConfig.enabled) {
    return res.status(503).json({
      error: 'A2A not enabled',
      message: 'A2A protocol is not enabled on this instance',
    });
  }

  // If no API keys configured, reject with security warning (require explicit auth)
  if (!a2aConfig.apiKeys || a2aConfig.apiKeys.length === 0) {
    log.warn('A2A request rejected — no API keys configured (auth required)', { path: req.path });
    return res.status(403).json({
      error: 'Forbidden',
      message: 'A2A API keys not configured. Set a2a.apiKeys in effy.config.yaml.',
    });
  }

  // Extract token from Authorization header or X-A2A-Key
  let token = null;

  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else {
    token = req.headers['x-a2a-key'];
  }

  if (!token) {
    log.warn('A2A request without authentication', {
      path: req.path,
      ip: req.ip,
    });
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing authentication token (Bearer or X-A2A-Key)',
    });
  }

  // Validate token (timing-safe comparison to prevent timing attacks)
  const validKeys = a2aConfig.apiKeys || [];
  const tokenBuf = Buffer.from(token);
  const isValid = validKeys.some(key => {
    const keyBuf = Buffer.from(key);
    if (tokenBuf.length !== keyBuf.length) return false;
    return crypto.timingSafeEqual(tokenBuf, keyBuf);
  });
  if (!isValid) {
    log.warn('A2A request with invalid token', {
      path: req.path,
      ip: req.ip,
    });
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid authentication token',
    });
  }

  // Token valid, attach to request
  req.a2aAuth = {
    token,
    validated: true,
  };

  next();
}

// ─── Middleware ────────────────────────────────────────────────────
router.use(express.json({ limit: '10mb' }));

// ─── GET /.well-known/agent.json — Agent Card Discovery (pre-auth, per A2A spec) ─
router.get('/.well-known/agent.json', (req, res) => {
  try {
    const card = generateAgentCard(config);
    res.json(card);
    log.debug('Agent card served');
  } catch (err) {
    log.error(`Failed to generate agent card: ${err.message}`, { error: err });
    res.status(500).json({
      error: 'Failed to generate agent card',
      message: err.message,
    });
  }
});

// Auth middleware applies to all routes AFTER agent.json discovery
router.use(authenticateA2A);

// ─── POST /a2a/tasks/send — Create and Execute Task ──────────────
router.post('/a2a/tasks/send', async (req, res) => {
  try {
    const { message, skill, context } = req.body;

    // Validate request
    if (!message || typeof message !== 'object' || !message.text) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Request must include message.text',
      });
    }

    // Create task
    const task = await taskManager.createTask({
      message,
      skill,
      context,
    });

    log.debug(`Task created via A2A: ${task.id}`, {
      skill: skill || 'general-chat',
    });

    // Execute task asynchronously (fire and forget for now)
    // In production, this could be queued for async processing
    taskManager.executeTask(task.id, agentConfig).catch((err) => {
      log.error(`Task execution failed: ${task.id}`, { error: err.message });
    });

    // Return task immediately (async execution)
    res.status(202).json({
      taskId: task.id,
      status: task.status,
      message: 'Task accepted for processing',
    });
  } catch (err) {
    log.error(`POST /a2a/tasks/send failed: ${err.message}`, { error: err });
    res.status(500).json({
      error: 'Failed to create task',
      message: err.message,
    });
  }
});

// ─── GET /a2a/tasks/:taskId — Get Task Status ─────────────────────
router.get('/a2a/tasks/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await taskManager.getTask(taskId);
    if (!task) {
      return res.status(404).json({
        error: 'Not found',
        message: `Task not found: ${taskId}`,
      });
    }

    res.json({
      id: task.id,
      status: task.status,
      artifacts: task.artifacts,
      history: task.history,
      metadata: task.metadata,
    });

    log.debug(`Task status retrieved: ${taskId}`, {
      state: task.status.state,
    });
  } catch (err) {
    log.error(`GET /a2a/tasks/:taskId failed: ${err.message}`, { error: err });
    res.status(500).json({
      error: 'Failed to retrieve task',
      message: err.message,
    });
  }
});

// ─── POST /a2a/tasks/:taskId/cancel — Cancel Task ──────────────────
router.post('/a2a/tasks/:taskId/cancel', async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await taskManager.cancelTask(taskId);
    if (!task) {
      return res.status(404).json({
        error: 'Not found',
        message: `Task not found: ${taskId}`,
      });
    }

    res.json({
      id: task.id,
      status: task.status,
      message: 'Task canceled',
    });

    log.info(`Task canceled via A2A: ${taskId}`);
  } catch (err) {
    log.error(`POST /a2a/tasks/:taskId/cancel failed: ${err.message}`, { error: err });
    res.status(500).json({
      error: 'Failed to cancel task',
      message: err.message,
    });
  }
});

// ─── 404 Handler ───────────────────────────────────────────────────
router.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `${req.method} ${req.path} not found`,
  });
});

// ─── Error Handler ─────────────────────────────────────────────────
router.use((err, req, res, next) => {
  log.error(`Unhandled A2A error: ${err.message}`, { error: err });
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred',
  });
});

module.exports = {
  router,
  initializeRouter,
};
