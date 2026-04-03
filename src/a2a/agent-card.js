/**
 * agent-card.js — A2A Agent Card (JSON-LD) Generator.
 *
 * Generates the Agent Card discovery document for /.well-known/agent.json
 * following the Google A2A standard (https://google.github.io/A2A/).
 *
 * The Agent Card describes:
 * - Agent identity and capabilities
 * - Available skills (intent mappings)
 * - Input/output modes
 * - Version and status
 */

const { version } = require('../../package.json');
const { createLogger } = require('../shared/logger');

const log = createLogger('a2a:agent-card');

/**
 * Generate Agent Card for A2A discovery.
 *
 * @param {object} config - Configuration object
 * @param {string} config.orgName - Organization name (optional)
 * @param {object} config.a2a - A2A configuration
 * @param {string} config.a2a.publicUrl - Public URL for this agent (optional)
 * @param {object} config.dashboard - Dashboard configuration
 * @param {string} config.dashboard.externalUrl - External URL (optional)
 * @returns {object} Agent Card (JSON-LD compatible)
 */
function generateAgentCard(config = {}) {
  const baseUrl = config.a2a?.publicUrl
    || config.dashboard?.externalUrl
    || 'http://localhost:3000';

  const agentCard = {
    '@context': 'https://schema.org',
    '@type': 'Agent',
    name: 'Effy',
    description: config.orgName
      ? `${config.orgName} AI Agent Platform`
      : 'Multi-Agent AI Platform',
    url: baseUrl,
    version: version,
    apiVersion: 'A2A-1.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
      asyncTaskExecution: true,
      taskCancellation: true,
    },
    skills: [
      {
        id: 'knowledge-query',
        name: 'Knowledge Query',
        description: 'Search team knowledge base (4-layer memory: episodic, semantic, entity, reflection)',
        category: 'information_retrieval',
      },
      {
        id: 'code-assist',
        name: 'Code Assistance',
        description: 'Code review, debugging, architecture guidance',
        category: 'engineering',
      },
      {
        id: 'ops-support',
        name: 'Operations Support',
        description: 'Incident triage, deployment support, monitoring',
        category: 'operations',
      },
      {
        id: 'strategy-analysis',
        name: 'Strategy Analysis',
        description: 'Decision analysis, planning, risk assessment',
        category: 'strategy',
      },
      {
        id: 'general-chat',
        name: 'General Chat',
        description: 'Team Q&A, task management, meeting notes',
        category: 'general',
      },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    authentication: {
      type: 'bearer',
      location: 'header',
      scheme: 'Bearer',
      headerName: 'Authorization',
      alternativeHeaders: ['X-A2A-Key'],
    },
    endpoints: {
      discovery: `${baseUrl}/.well-known/agent.json`,
      taskSubmit: `${baseUrl}/a2a/tasks/send`,
      taskStatus: `${baseUrl}/a2a/tasks/:taskId`,
      taskCancel: `${baseUrl}/a2a/tasks/:taskId/cancel`,
    },
    rateLimit: {
      tasksPerMinute: 60,
      tasksPerHour: 1000,
      concurrent: 10,
    },
    supported: {
      taskFormats: ['structured'],
      responseFormats: ['structured'],
      contextTypes: ['user', 'organization', 'system'],
    },
  };

  log.debug('Agent Card generated', {
    version: agentCard.version,
    skillCount: agentCard.skills.length,
  });

  return agentCard;
}

module.exports = {
  generateAgentCard,
};
