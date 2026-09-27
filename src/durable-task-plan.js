'use strict';

const ROLES = ['researcher', 'developer', 'reviewer', 'verifier'];
const LEVELS = ['bachelor', 'master', 'doctor'];
const BUDGETS = ['small', 'medium', 'large'];
const itemSchema = {
  type: 'object', required: ['title', 'execution_kind', 'validation'],
  properties: {
    title: { type: 'string', minLength: 1 },
    stage: { type: 'string' }, instructions: { type: 'string' },
    execution_kind: { type: 'string', enum: ['agent', 'programmatic'] },
    executor_role: { type: ['string', 'null'], enum: [...ROLES, null] },
    minimum_model_level: { type: ['string', 'null'], enum: [...LEVELS, null] },
    context_budget: { type: ['string', 'null'], enum: [...BUDGETS, null] },
    validation: { type: 'object', minProperties: 1 },
    delay_after_sec: { type: 'integer', minimum: 0 },
    max_attempts: { type: 'integer', minimum: 1 },
    execution_timeout_seconds: { type: 'integer', minimum: 1 },
    wait: {
      type: 'object',
      properties: {
        poll_every_sec: { type: 'integer', minimum: 60 },
        timeout_sec: { type: 'integer', minimum: 60 },
      },
    },
  },
};
function validateItem(item) {
  if (!item || typeof item.title !== 'string' || !item.title.trim()) throw new Error('item title required');
  if (!['agent', 'programmatic'].includes(item.execution_kind)) throw new Error('invalid execution_kind');
  for (const [key, values] of [['executor_role', ROLES], ['minimum_model_level', LEVELS], ['context_budget', BUDGETS]]) {
    if (item.execution_kind === 'programmatic' && item[key] == null) continue;
    if (!values.includes(item[key])) throw new Error(`invalid ${key}`);
  }
  if (!item.validation || typeof item.validation !== 'object' || Array.isArray(item.validation) || !Object.keys(item.validation).length) throw new Error('item validation required');
  for (const key of ['delay_after_sec', 'max_attempts', 'execution_timeout_seconds']) {
    if (item[key] != null && (!Number.isSafeInteger(item[key]) || item[key] < (key === 'delay_after_sec' ? 0 : 1))) throw new Error(`invalid ${key}`);
  }
  // A declared wait polls the step's own validations until they pass — only a
  // programmatic step has validations a poll can evaluate without a model.
  if (item.wait != null) {
    if (item.execution_kind !== 'programmatic') throw new Error('wait is only allowed on programmatic steps');
    if (typeof item.wait !== 'object' || Array.isArray(item.wait)) throw new Error('invalid wait');
    for (const key of ['poll_every_sec', 'timeout_sec']) {
      if (!Number.isSafeInteger(item.wait[key]) || item.wait[key] < 60) throw new Error(`invalid wait.${key}`);
    }
  }
}

// ── Acceptance criteria + criterion_id scheme ───────────────────────────────
// The executor records a validation row (criterion, validator) and the P3d-2
// finalization gate reads those rows back. Both must key a criterion the same
// way, so the scheme lives here — one definition, no drift.
function parseAcceptanceCriteria(criteriaJson) {
  try {
    const criteria = criteriaJson ? JSON.parse(criteriaJson) : null;
    return Array.isArray(criteria) ? criteria : [];
  } catch { return []; }
}

// Which acceptance criterion does this validation belong to? Prefer the
// criterion whose validations declare this key for this step; fall back to the
// plan's single criterion, then to the item's stage/position.
function criterionIdForItem(task, item, validatorKey) {
  const criteria = parseAcceptanceCriteria(task && task.acceptance_criteria_json);
  if (criteria.length) {
    for (const c of criteria) {
      const validations = Array.isArray(c && c.validations) ? c.validations : [];
      for (const v of validations) {
        const obj = v && v.validation;
        if (obj && typeof obj === 'object'
          && Object.prototype.hasOwnProperty.call(obj, validatorKey)
          && (v.step == null || v.step === item.title)) {
          return (c && c.id) || 'acceptance';
        }
      }
    }
    if (criteria.length === 1 && criteria[0] && criteria[0].id) return criteria[0].id;
  }
  return item.stage != null ? String(item.stage) : 'acceptance';
}

// Every (criterion_id, validator) pair a plan declares, deduped. The gate
// requires a 'pass' row for each. A criterion with no `validations` array
// declares nothing machine-checkable — there is nothing for the gate to check.
function declaredValidations(task) {
  const criteria = parseAcceptanceCriteria(task && task.acceptance_criteria_json);
  const out = [];
  const seen = new Set();
  for (const c of criteria) {
    const validations = Array.isArray(c && c.validations) ? c.validations : [];
    for (const v of validations) {
      const obj = v && v.validation;
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      const criterionId = (c && c.id) || 'acceptance';
      for (const key of Object.keys(obj)) {
        const dedupe = `${criterionId}\u0000${key}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        out.push({ criterion_id: criterionId, validator: key });
      }
    }
  }
  return out;
}

module.exports = { itemSchema, validateItem, parseAcceptanceCriteria, criterionIdForItem, declaredValidations };
