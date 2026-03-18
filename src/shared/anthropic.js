/**
 * anthropic.js — Anthropic SDK 싱글턴.
 *
 * 3곳(runtime, indexer, webhook)에서 개별 인스턴스 생성하던 것을 통합.
 * HTTP 커넥션 풀 재사용 + 코드 중복 제거.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

module.exports = { client };
