/**
 * a2a/index.js — Unified entry point for A2A (Agent-to-Agent) module.
 *
 * Usage:
 *   const { A2ATaskManager, generateAgentCard, initializeRouter, createA2ARouter } = require('./a2a');
 *
 * @module a2a
 */

const { A2ATaskManager } = require('./task-manager');
const { generateAgentCard } = require('./agent-card');
const { router: a2aRouter, initializeRouter } = require('./router');

module.exports = {
  A2ATaskManager,
  generateAgentCard,
  initializeRouter,
  a2aRouter,
};
