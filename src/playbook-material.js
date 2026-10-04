'use strict';

// Material result criteria (#106 / R2, owner: «мягко по формату, твёрдо по результату»).
//
// A plan's acceptance criteria are derived from every step's `validation` object
// (playbook-compiler.js deriveAcceptanceCriteria), and finalization only blocks on
// keys in the VALIDATOR REGISTRY (gtd-controller.js isBlockingCheck). Semantic keys —
// which is most of them — therefore end as `unconfirmed` defects and the plan still
// becomes `done`. The concrete hole: `pr_opened` + `ci_green` + `merged` all pass and
// nothing proves the change is LIVE, the docs landed, or the user scenario works.
//
// These keys are the ones whose verdict IS the delivered result. A pass on an input or
// a CI signal never stands in for them. Format stays soft: every legitimate closure
// path still works (the step's own judge verdict, an explicit `task_item_exception`
// with a reason, `finalization: strict`), and nothing new is asked of any individual
// step — the rule is only that the plan may not REPORT done without them.
//
// Deliberately NOT material:
//   • `sandbox_*` — #121 allows the red loop to be woven into `implement`, so a
//     standalone sandbox step is legitimately absent or closed;
//   • `open-pr` / `ci-green` / `merged` — already blocking, they are registry keys;
//   • the whole frame/propose chain (scenario, context, flags, design, issue) — inputs,
//     not the result. They stay advisory on purpose.

const MATERIAL_RESULT_VALIDATORS = new Set([
  'implementation_complete_and_sandbox_green', // implement — the code + its loop
  'local_checks_and_tests_green',               // verify-local
  'repo_bootstrapped_with_ci_and_docs',        // repo-bootstrap
  'running_in_real_environment',               // go-live
  'deployed_version_is_live',                  // deployed
  'user_scenario_verified_in_real_environment', // verify-real
  'error_gone_in_production',                  // confirm-fixed
  'post_release_observation_done_or_not_needed', // observe
  'living_docs_updated_and_plan_closed',       // archive
  'acceptance_checklist_run_and_report_published_or_continuation_added', // final-acceptance
  'cloud_test_result_reported',                // ci-run
]);

// A material key blocks plan finalization even under the default (soft) mode.
function isMaterialValidator(key) {
  return MATERIAL_RESULT_VALIDATORS.has(key);
}

function materialOf(validators) {
  return (validators || []).filter(isMaterialValidator);
}

module.exports = { MATERIAL_RESULT_VALIDATORS, isMaterialValidator, materialOf };
