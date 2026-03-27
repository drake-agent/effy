/**
 * schema/index.js — 런타임 타입 검증 스키마.
 * Zod 패턴의 경량 인라인 구현 (외부 의존성 없음).
 */

class SchemaError extends Error {
  constructor(message, typeName) {
    super(`Schema validation failed [${typeName}]: ${message}`);
    this.name = 'SchemaError';
    this.typeName = typeName;
  }
}

class Schema {
  constructor(validator, typeName = 'schema') {
    this._validate = validator;
    this._typeName = typeName;
    this._optional = false;
  }

  parse(value) {
    if (this._optional && (value === undefined || value === null)) return value;
    const result = this._validate(value);
    if (!result.ok) throw new SchemaError(result.error, this._typeName);
    return result.value;
  }

  optional() {
    const clone = new Schema(this._validate, this._typeName);
    clone._optional = true;
    return clone;
  }

  static string(opts = {}) {
    const { min, max, pattern } = opts;
    const typeName = 'string';

    return new Schema((value) => {
      if (typeof value !== 'string') {
        return { ok: false, error: `expected string, got ${typeof value}` };
      }
      if (min !== undefined && value.length < min) {
        return { ok: false, error: `string length must be >= ${min}` };
      }
      if (max !== undefined && value.length > max) {
        return { ok: false, error: `string length must be <= ${max}` };
      }
      if (pattern !== undefined && !pattern.test(value)) {
        return { ok: false, error: `string does not match pattern ${pattern}` };
      }
      return { ok: true, value };
    }, typeName);
  }

  static number(opts = {}) {
    const { min, max, integer } = opts;
    const typeName = 'number';

    return new Schema((value) => {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return { ok: false, error: `expected number, got ${typeof value}` };
      }
      if (integer && !Number.isInteger(value)) {
        return { ok: false, error: 'expected integer' };
      }
      if (min !== undefined && value < min) {
        return { ok: false, error: `number must be >= ${min}` };
      }
      if (max !== undefined && value > max) {
        return { ok: false, error: `number must be <= ${max}` };
      }
      return { ok: true, value };
    }, typeName);
  }

  static boolean() {
    return new Schema((value) => {
      if (typeof value !== 'boolean') {
        return { ok: false, error: `expected boolean, got ${typeof value}` };
      }
      return { ok: true, value };
    }, 'boolean');
  }

  static array(itemSchema) {
    return new Schema((value) => {
      if (!Array.isArray(value)) {
        return { ok: false, error: `expected array, got ${typeof value}` };
      }
      const validated = [];
      for (let i = 0; i < value.length; i++) {
        try {
          validated.push(itemSchema.parse(value[i]));
        } catch (err) {
          return { ok: false, error: `array[${i}]: ${err.message}` };
        }
      }
      return { ok: true, value: validated };
    }, 'array');
  }

  static object(shape) {
    return new Schema((value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: `expected object, got ${typeof value}` };
      }
      const validated = {};
      const shapeKeys = Object.keys(shape);

      for (const key of shapeKeys) {
        const schema = shape[key];
        const val = value[key];

        try {
          validated[key] = schema.parse(val);
        } catch (err) {
          return { ok: false, error: `object.${key}: ${err.message}` };
        }
      }

      // Passthrough extra properties — skip dangerous keys (__proto__, constructor, prototype)
      const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
      for (const key of Object.keys(value)) {
        if (!(key in shape) && !BLOCKED_KEYS.has(key)) {
          validated[key] = value[key];
        }
      }

      return { ok: true, value: validated };
    }, 'object');
  }

  static enum(values) {
    const valueSet = new Set(values);
    return new Schema((value) => {
      if (!valueSet.has(value)) {
        return { ok: false, error: `expected one of ${JSON.stringify(values)}, got ${JSON.stringify(value)}` };
      }
      return { ok: true, value };
    }, 'enum');
  }

  static any() {
    return new Schema((value) => {
      return { ok: true, value };
    }, 'any');
  }

  static record(keySchema, valueSchema) {
    return new Schema((value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: `expected object, got ${typeof value}` };
      }
      const validated = {};

      for (const [key, val] of Object.entries(value)) {
        try {
          const validatedKey = keySchema.parse(key);
          const validatedVal = valueSchema.parse(val);
          validated[validatedKey] = validatedVal;
        } catch (err) {
          return { ok: false, error: `record[${key}]: ${err.message}` };
        }
      }

      return { ok: true, value: validated };
    }, 'record');
  }
}

// ===== Predefined Schemas =====

// Agent Request
const AgentRequestSchema = Schema.object({
  agentId: Schema.string({ min: 1 }),
  content: Schema.string({ min: 1 }),
  channelId: Schema.string().optional(),
  context: Schema.any().optional(),
  tools: Schema.array(Schema.any()).optional(),
  model: Schema.string().optional(),
});

// Agent Response
const AgentResponseSchema = Schema.object({
  success: Schema.boolean(),
  output: Schema.string(),
  tokens: Schema.number({ min: 0, integer: true }).optional(),
  toolCalls: Schema.array(Schema.any()).optional(),
  error: Schema.string().optional(),
  latencyMs: Schema.number({ min: 0 }).optional(),
});

// Memory Entry
const MemoryEntrySchema = Schema.object({
  id: Schema.string({ min: 1 }),
  content: Schema.string({ min: 1 }),
  type: Schema.enum(['episodic', 'semantic', 'procedural', 'working']),
  agentId: Schema.string().optional(),
  channelId: Schema.string().optional(),
  importance: Schema.number({ min: 0, max: 1 }).optional(),
  timestamp: Schema.number().optional(),
});

// Error Classification
const ErrorClassificationSchema = Schema.object({
  category: Schema.enum(['rate_limit', 'context_overflow', 'auth', 'invalid_request', 'model_unavailable', 'quota_exceeded', 'network', 'timeout', 'unknown']),
  retriable: Schema.boolean(),
  fallbackAllowed: Schema.boolean(),
  suggestedBackoffMs: Schema.number({ min: 0 }),
  provider: Schema.string({ min: 1 }),
  originalCode: Schema.string().optional(),
  message: Schema.string().optional(),
});

// Tool Definition
const ToolDefinitionSchema = Schema.object({
  name: Schema.string({ min: 1, max: 64 }),
  description: Schema.string({ min: 1 }),
  input_schema: Schema.any(),
});

// Config validation schemas
const LLMConfigSchema = Schema.object({
  primary: Schema.string().optional(),
  model: Schema.string().optional(),
  maxTokens: Schema.number({ min: 1, max: 200000 }).optional(),
  temperature: Schema.number({ min: 0, max: 2 }).optional(),
});

module.exports = {
  Schema,
  SchemaError,
  AgentRequestSchema,
  AgentResponseSchema,
  MemoryEntrySchema,
  ErrorClassificationSchema,
  ToolDefinitionSchema,
  LLMConfigSchema,
};
