export interface MetricDefinition {
  id: string;
  name: string;
  numerator: string;
  denominator: string;
  exclusions: string;
  aggregation: string;
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    id: "task_success_rate",
    name: "Task success rate",
    numerator: "Tasks whose outcome is succeeded.",
    denominator:
      "Tasks that reached a terminal task verdict: succeeded, failed, invalid_output, timeout, or retry_exhausted.",
    exclusions:
      "Cancelled, infrastructure_error, and incomplete tasks are excluded. They are counted separately and are never treated as successes. Tasks that were never started are reported as notRun and excluded.",
    aggregation:
      "One task is one sample. The rate is numerator divided by denominator. The rate is null when the denominator is 0. Reports always show both counts. If the denominator is below the configured minimum sample size (default 10), the rate is still calculated and flagged small-sample.",
  },
  {
    id: "exact_match_accuracy",
    name: "Exact-match accuracy",
    numerator: "Applicable tasks whose exact_match criterion passed.",
    denominator:
      "Evaluated tasks that declare validation method exact_match or include an exact_match criterion. Timeouts and other unsuccessful evaluated outcomes count in the denominator and do not count as matches.",
    exclusions:
      "Tasks without an exact-match criterion are omitted, not failed. Cancelled, infrastructure_error, and incomplete tasks are excluded. The metric is null when no task is applicable.",
    aggregation:
      "Deep equality on canonical JSON. Object key order does not matter. A missing or unparsed output does not match. Sample size is the denominator.",
  },
  {
    id: "schema_compliance_rate",
    name: "Schema compliance rate",
    numerator: "Applicable tasks whose json_schema criterion passed.",
    denominator:
      "Evaluated tasks with validation method json_schema or a json_schema criterion, including invalid_output, failed, timeout, and retry_exhausted.",
    exclusions:
      "Tasks that do not ask for schema validation are omitted. Cancelled, infrastructure_error, and incomplete tasks are excluded. Invalid JSON is non-compliant, not excluded.",
    aggregation:
      "Checked with the lab's JSON Schema subset (type, required, properties, items, enum, additionalProperties, minLength). The rate is null when no task is applicable.",
  },
  {
    id: "tool_call_success_rate",
    name: "Tool-call success rate",
    numerator: "Sandbox tool calls whose status is success.",
    denominator: "Every recorded sandbox tool call, including error, timeout, and not_permitted.",
    exclusions:
      "Calls that were refused by the hard cap are still recorded once and count as errors. Tasks with no tool calls contribute nothing. The rate is null when there are no calls.",
    aggregation:
      "The harness trace is authoritative. Call claims inside the model output are ignored. Each attempt is its own sample.",
  },
  {
    id: "recovery_success_rate",
    name: "Recovery success rate",
    numerator:
      "Applicable tasks where a configured fault produced an earlier unsuccessful call, a later call to that tool succeeded within maxAttempts, and the answer criteria also passed.",
    denominator: "Evaluated tasks that include a recovery criterion.",
    exclusions:
      "Tasks with no recovery criterion are omitted. Cancelled, infrastructure_error, and incomplete tasks are excluded. An agent claim such as recovered:true is not evidence. A later successful tool call with a wrong answer is not recovery.",
    aggregation:
      "maxAttempts counts every call, including the first. The rate is null when no recovery task was evaluated.",
  },
  {
    id: "failure_rate_by_category",
    name: "Failure rate by category",
    numerator:
      "Evaluated tasks in that category whose outcome is failed, invalid_output, timeout, or retry_exhausted.",
    denominator: "Evaluated tasks in that category.",
    exclusions:
      "Cancelled, infrastructure_error, and incomplete tasks are omitted from both counts. Categories with no evaluated tasks are omitted.",
    aggregation:
      "Computed per category using the same evaluated set as task success rate. Within a category, failure rate and success rate are complements. Each category shows its own sample size.",
  },
  {
    id: "median_latency",
    name: "Median latency",
    numerator: "Not a ratio. The nearest-rank 50th percentile of latency samples.",
    denominator: "Not a ratio. The sample is the latency list described under aggregation.",
    exclusions:
      "Tasks with no finite harness duration are excluded and counted as excludedMissingTimestamps. Agent-reported timestamps are stored but not used.",
    aggregation:
      "Latency is harness wall-clock milliseconds from just before adapter execution until it returns, including injected delays that were actually awaited. Nearest rank: sort ascending, rank = ceil(p/100 * n), index = rank - 1. This is not an average of the two middle values. Null when there are no samples.",
  },
  {
    id: "p95_latency",
    name: "p95 latency",
    numerator: "Not a ratio. The nearest-rank 95th percentile of the same latency samples as the median.",
    denominator: "Same sample as median latency.",
    exclusions: "Same exclusions as median latency.",
    aggregation:
      "Same nearest-rank method as the median, with p = 95. For a single sample, p95 is that sample. Null when there are no samples.",
  },
  {
    id: "token_usage",
    name: "Token usage",
    numerator: "Sum of input, output, and total tokens on tasks that reported usage.",
    denominator: "Not a rate. Coverage is tasksWithUsage compared with tasksMissingUsage among all recorded tasks.",
    exclusions:
      "Tasks that do not report usage contribute nothing to the sums. Missing usage is never filled with zero. When no task reports usage, the sums are null.",
    aggregation:
      "Sums are partial totals over the covered tasks only. The report always includes coverage counts.",
  },
  {
    id: "estimated_cost_per_run",
    name: "Estimated cost per run",
    numerator: "Sum of estimatedCostUsd on tasks where a cost was calculated.",
    denominator:
      "meanPerRunUsd divides that sum by tasksWithCost. It is null when no task has a cost.",
    exclusions:
      "Missing cost is never treated as zero. Scripted runs record cost as unavailable. A model call records cost only when token usage and a matching price-card entry both exist.",
    aggregation:
      "Cost is a price-card estimate, not a provider invoice. The currency is USD. Coverage counts are always reported.",
  },
  {
    id: "cost_per_successful_task",
    name: "Cost per successful task",
    numerator: "Sum of estimatedCostUsd on succeeded tasks that have a cost.",
    denominator: "Number of succeeded tasks that have a cost.",
    exclusions:
      "Succeeded tasks without a cost are excluded from both the sum and the divisor and counted in successesMissingCost. Failed tasks are not included. The value is null when the divisor is 0.",
    aggregation:
      "This is a covered-success average. It is not total spend divided by all successes unless every success has a cost. Coverage is reported beside the value.",
  },
  {
    id: "retry_count",
    name: "Retry count",
    numerator: "Sum of retries on evaluated tasks. A retry is a sandbox call whose attempt number is greater than 1.",
    denominator: "Evaluated task count, for the mean. The total is also reported.",
    exclusions:
      "Calls on cancelled, infrastructure_error, or incomplete tasks are not included. The first attempt is not a retry. The mean is null when there are no evaluated tasks.",
    aggregation: "Mean is total retries divided by evaluated tasks. The distribution is visible on each task result.",
  },
  {
    id: "timeout_rate",
    name: "Timeout rate",
    numerator: "Tasks whose outcome is timeout.",
    denominator: "Evaluated tasks (the same set as task success rate).",
    exclusions:
      "Cancelled, infrastructure_error, and incomplete tasks are excluded. A timeout is not counted as a successful task.",
    aggregation:
      "Rate is numerator divided by denominator, null when the denominator is 0. Tool-call timeouts that the agent converts into a final answer without aborting the task are not task timeouts; they appear in the tool trace.",
  },
];

export function definitionById(id: string): MetricDefinition | undefined {
  return METRIC_DEFINITIONS.find((definition) => definition.id === id);
}
