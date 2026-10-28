import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('Watch discovery is bounded while all daily totals retain their full period', () => {
  const script = `import importlib.util,json
s=importlib.util.spec_from_file_location('shortcut','scripts/build-health-shortcut.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.build()))`;
  const workflow = JSON.parse(execFileSync('python3', ['-B', '-c', script], { encoding: 'utf8' }));
  const actions = workflow.WFWorkflowActions;
  const queries = actions.filter(a => a.WFWorkflowActionIdentifier === 'is.workflow.actions.filter.health.quantity');
  const rows = a => a.WFWorkflowActionParameters.WFContentItemFilter.Value.WFActionParameterFilterTemplates;
  const activity = queries.filter(a => rows(a).find(r => r.Property === 'Type').Values.Enumeration.Value === 'Active Calories');
  assert.equal(activity.length, 2);
  const [discovery, totals] = activity.map(a => a.WFWorkflowActionParameters);
  assert.equal(discovery.WFHKSampleFilteringGroupBy, undefined);
  assert.equal(discovery.WFContentItemSortOrder, 'Latest First');
  assert.equal(discovery.WFContentItemLimitEnabled, true);
  assert.equal(discovery.WFContentItemLimitNumber, 100);
  // A discovery cap must never truncate calories, protein or other daily sums.
  const dailyQueries = queries.filter(a => a.WFWorkflowActionParameters.WFHKSampleFilteringGroupBy === 'Day');
  assert.equal(dailyQueries.length, 5);
  for (const query of dailyQueries) {
    assert.equal(query.WFWorkflowActionParameters.WFContentItemLimitEnabled, false);
    assert.equal(query.WFWorkflowActionParameters.WFContentItemLimitNumber, undefined);
  }
  const source = rows(activity[1]).find(r => r.Property === 'Source');
  assert.equal(source.Operator, 4); // Exact selected source, not every tracker.
  assert.equal(source.Values.Enumeration.WFSerializationType, 'WFTextTokenAttachment');
  assert.equal(source.Values.Enumeration.Value.Type, 'ActionOutput');
  const selector = actions.find(a => a.WFWorkflowActionParameters.UUID === source.Values.Enumeration.Value.OutputUUID);
  assert.equal(selector.WFWorkflowActionIdentifier, 'is.workflow.actions.conditional');
  assert.equal(selector.WFWorkflowActionParameters.WFControlFlowMode, 2);
  assert.equal(totals.WFHKSampleFilteringGroupBy, 'Day');
  assert.equal(totals.WFHKSampleFilteringFillMissing, false);
  const firstLoop = actions.findIndex(a => a.WFWorkflowActionIdentifier === 'is.workflow.actions.repeat.each');
  assert.ok(actions.indexOf(selector) < firstLoop);
  const payload = actions.find(a => a.WFWorkflowActionParameters.WFTextActionText?.Value?.string?.startsWith('{"version":5'));
  assert.ok(payload);
  assert.match(payload.WFWorkflowActionParameters.WFTextActionText.Value.string, /"activitySelection":/);
  assert.equal(/wedx_[a-f0-9]{64}/.test(JSON.stringify(workflow)), false);
});
