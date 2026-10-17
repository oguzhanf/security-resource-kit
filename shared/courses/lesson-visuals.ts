import type { Lesson, LessonVisual } from '../content-types';
import media from '../training-media.json' with { type: 'json' };

type NodeText = readonly [label: string, detail: string];
interface VisualPlan {
  title: string;
  caption: string;
  nodes: readonly NodeText[];
  checkTitle: string;
  checks: readonly NodeText[];
}

const plans: Record<string, VisualPlan> = {
  'identity-model': {
    title: 'Credential, acting identity, and user-only access',
    caption: 'Read the objects separately. The sponsor supplies accountability, not a runtime credential.',
    nodes: [['Blueprint', 'Holds authentication material'], ['Agent identity', 'Permissions and audit identity'], ['Paired agent user', 'Optional user-only resources']],
    checkTitle: 'Inventory before authorization',
    checks: [['Classify', 'Inspect the actual object type'], ['Map', 'Trace parent and paired objects'], ['Account for access', 'Record grants, owners, and sponsor']],
  },
  'blueprint-boundaries': {
    title: 'Child separation is not credential isolation',
    caption: 'One parent credential reaches its children. Independent trust boundaries require independent parent authentication material.',
    nodes: [['Runtime boundary', 'Identify shared credential exposure'], ['Blueprint boundary', 'Separate isolated authentication'], ['Child identities', 'Separate attribution and permissions']],
    checkTitle: 'Choose the object count',
    checks: [['Containment scope', 'Decide what must stay isolated'], ['Logical agents', 'Compare permissions and lifecycle'], ['Replicas', 'Scaling alone adds no boundary']],
  },
  'token-paths': {
    title: 'Exchange, token subject, resource validation',
    caption: 'The credential holder and downstream subject are not interchangeable. Follow the selected autonomous or delegated path.',
    nodes: [['Blueprint exchange', 'Use the supported identity SDK'], ['Access token', 'Inspect subject, actor, audience'], ['Resource', 'Validate token and authorization']],
    checkTitle: 'Validate the operation',
    checks: [['Subject', 'Which identity is represented?'], ['Audience', 'Which resource accepts the token?'], ['Authorization', 'Which operation is permitted?']],
  },
  'permission-inheritance': {
    title: 'Declaration is not consent',
    caption: 'Confirm the resource, actual grant, and effective child access. Keep the documented inheritance discrepancy visible.',
    nodes: [['Required access', 'Declares intended permissions'], ['Consent and grants', 'Authorize the resource access'], ['Effective child access', 'Verify inheritance and direct grants']],
    checkTitle: 'Review the grant chain',
    checks: [['Resource', 'Confirm the target API'], ['Grant', 'Inspect consent and app roles'], ['Child', 'Test effective least privilege']],
  },
  'conditional-access': {
    title: 'Policy follows the access path',
    caption: 'A policy targeting one subject does not cover every agent operation. External keys need separate controls.',
    nodes: [['Access path', 'Autonomous, delegated, paired user'], ['Policy target', 'Match the represented subject'], ['Enforcement', 'Test each resource and external key']],
    checkTitle: 'Build the coverage matrix',
    checks: [['Enumerate', 'Subject, audience, credential'], ['Evaluate', 'Use report-only before enforcement'], ['Verify', 'Include non-Entra access paths']],
  },
  'investigate-contain': {
    title: 'From observed child to defensible incident scope',
    caption: 'Correlate identity and resource telemetry before claiming scope. Verify residual access after approved containment.',
    nodes: [['Observed operation', 'Preserve UTC resource evidence'], ['Credential scope', 'Map parent, siblings, paired user'], ['Verified containment', 'Check tokens and external keys']],
    checkTitle: 'Prepare the response handoff',
    checks: [['Preserve', 'Record authorized observations'], ['Scope', 'Separate evidence from inference'], ['Verify', 'Record stopped and residual access']],
  },
  'mdti-entitlement': {
    title: 'Entitlement, authorization, and workflow availability',
    caption: 'Product inclusion is one gate. It does not grant API consent, workspace access, or every preview capability.',
    nodes: [['Service entitlement', 'Check the current XDR/Sentinel plan'], ['Authorization', 'Validate role and operation consent'], ['Workflow', 'Check preview, workspace, and charges']],
    checkTitle: 'Separate the eligibility checks',
    checks: [['Current guidance', 'Use the integrated experience'], ['Access configuration', 'Check cloud, consent, and role'], ['Preview conditions', 'Assess ISOC independently']],
  },
  'mdti-graph-api': {
    title: 'Workload identity to a Graph TI read',
    caption: 'A correctly authorized Graph token reaches the documented TI operation. Hunting and uploads remain separate surfaces.',
    nodes: [['Workload identity', 'Approved application permission'], ['Graph token', 'Correct audience and tenant'], ['TI operation', 'Use the supported v1.0 method']],
    checkTitle: 'Diagnose a failed enrichment',
    checks: [['Token', 'Verify audience and grant'], ['Method', 'Check operation-specific permission'], ['Availability', 'Check entitlement and service support']],
  },
  'mdti-entity-investigation': {
    title: 'Entity evidence and intelligence are different',
    caption: 'Threat intelligence adds context to observed tenant activity; reputation alone does not establish compromise.',
    nodes: [['Observed entity', 'Start from authorized evidence'], ['TI context', 'Compare reputation and relationships'], ['Investigation decision', 'Corroborate locally and record doubt']],
    checkTitle: 'Qualify an entity pivot',
    checks: [['Normalize', 'Use the actual entity type'], ['Corroborate', 'Compare local events and TI'], ['Conclude', 'State evidence and uncertainty']],
  },
  'mdti-infrastructure': {
    title: 'Infrastructure relationships need time context',
    caption: 'Shared hosting and historical DNS produce leads, not proof that every connected entity has the same owner.',
    nodes: [['Seed indicator', 'Use a synthetic authorized artifact'], ['Time-bounded pivot', 'Compare DNS and infrastructure'], ['Corroboration', 'Test ownership and alternative causes']],
    checkTitle: 'Validate a relationship',
    checks: [['Record type', 'Use the required API filter'], ['Observation time', 'Compare first and last observations'], ['Attribution', 'Do not equate shared hosting with control']],
  },
  'mdti-hunting': {
    title: 'Join intelligence to activity in time',
    caption: 'Bound the hunt, normalize artifacts, and respect indicator validity. A matching event still needs investigation.',
    nodes: [['Indicator set', 'Normalize type and validity'], ['Bounded event query', 'Use the correct hunting surface'], ['Evidence review', 'Retain event keys and context']],
    checkTitle: 'Check the join',
    checks: [['Normalize', 'Compare hosts, not entire URLs'], ['Time-bound', 'Intersect event and validity windows'], ['Validate', 'Inspect matching events and coverage']],
  },
  'mdti-indicator-management': {
    title: 'An indicator has a lifecycle',
    caption: 'Track provenance, validity, confidence, and revocation. Ingestion is not the same action as blocking.',
    nodes: [['Create or ingest', 'Authorize the workspace operation'], ['Maintain', 'Review validity and metadata'], ['Expire or revoke', 'Verify downstream consumers']],
    checkTitle: 'Check an indicator change',
    checks: [['Provenance', 'Record source and usage conditions'], ['Validity', 'Avoid keeping stale indicators active'], ['Consumer', 'Verify analytic and response behavior']],
  },
  'mdti-third-party-access': {
    title: 'Read permission is not redistribution permission',
    caption: 'Keep TI enrichment, hunting, workspace writes, and external distribution under separate authorization and usage checks.',
    nodes: [['TI integration', 'Use an approved identity and API'], ['Intended use', 'Check permissions and data terms'], ['External consumer', 'Limit scope, retention, redistribution']],
    checkTitle: 'Review an integration boundary',
    checks: [['Operation', 'TI read, hunt, upload, or export?'], ['Authorization', 'Check each separate API grant'], ['Distribution', 'Confirm permitted use before forwarding']],
  },
  'mdti-case-workflow': {
    title: 'From intelligence lead to reviewed handoff',
    caption: 'Separate observations from hypotheses. The handoff should explain the evidence, limitations, and next authorized action.',
    nodes: [['Intelligence lead', 'Capture provenance and UTC context'], ['Tenant evidence', 'Corroborate using bounded hunts'], ['Decision and handoff', 'Record confidence and next owner']],
    checkTitle: 'Make the case reproducible',
    checks: [['Preserve', 'Record sources and query windows'], ['Evaluate', 'Test alternatives and uncertainty'], ['Handoff', 'Name the decision and next action']],
  },
  'xdr-incident-triage': {
    title: 'Correlation is the start of triage',
    caption: 'Review why alerts are grouped, assess impact, then assign an owner. Incident grouping can change as evidence arrives.',
    nodes: [['Correlated incident', 'Inspect alerts and entities'], ['Prioritization', 'Evaluate impact and uncertainty'], ['Ownership', 'Assign next investigative action']],
    checkTitle: 'Triage without premature closure',
    checks: [['Validate grouping', 'Check the underlying alerts'], ['Assess impact', 'Consider affected critical assets'], ['Record ownership', 'Preserve scope and next action']],
  },
  'xdr-entity-timelines': {
    title: 'Build a qualified event sequence',
    caption: 'Use entity and process-instance identifiers with timestamps. Nearby events are not automatically one causal chain.',
    nodes: [['Entity context', 'Identify the actual device or user'], ['Process instance', 'Join stable event identifiers'], ['Qualified timeline', 'Separate order from causation']],
    checkTitle: 'Validate a timeline pivot',
    checks: [['Identify', 'Confirm entity and process instance'], ['Bound time', 'Align UTC and collection windows'], ['Corroborate', 'Record what the sequence does not prove']],
  },
  'xdr-advanced-hunting': {
    title: 'Turn a hypothesis into validated evidence',
    caption: 'Begin with a question and available telemetry. Narrow the query before interpreting results or promoting a detection.',
    nodes: [['Hypothesis', 'Name the expected behavior'], ['Bounded query', 'Filter early and retain evidence keys'], ['Validation', 'Inspect results and coverage gaps']],
    checkTitle: 'Review the hunting result',
    checks: [['Coverage', 'Check the table and collection scope'], ['Query bounds', 'Limit time and preserve event keys'], ['Interpretation', 'Empty results do not prove absence']],
  },
  'xdr-custom-detections': {
    title: 'A useful hunt needs a detection release process',
    caption: 'Validate required identifiers, scheduling, and noise before enabling response. Review rule health after release.',
    nodes: [['Validated hunt', 'Return the required event columns'], ['Pilot detection', 'Test frequency, scope, and noise'], ['Monitored release', 'Review health and response effects']],
    checkTitle: 'Gate a detection change',
    checks: [['Evidence keys', 'Keep the required original columns'], ['Pilot', 'Assess false positives and latency'], ['Release', 'Assign owner and monitor failures']],
  },
  'xdr-response-control': {
    title: 'Request, execution, and outcome are separate',
    caption: 'Use the authorized response scope and approvals. An accepted request is not proof that containment succeeded.',
    nodes: [['Authorization', 'Validate role, scope, and approval'], ['Response execution', 'Track the action in Action center'], ['Verified outcome', 'Check target state and residual risk']],
    checkTitle: 'Close the response loop',
    checks: [['Authorize', 'Follow the approved response process'], ['Track', 'Review pending and failed actions'], ['Verify', 'Confirm containment at the target']],
  },
  'xdr-operational-readiness': {
    title: 'Readiness needs coverage and usable authority',
    caption: 'A connected product is not proof of complete telemetry. Test access, data freshness, and operational handoffs.',
    nodes: [['Coverage', 'Check onboarding and fresh telemetry'], ['Authority', 'Test analyst and response scopes'], ['Handoff gate', 'Record gaps and escalation owner']],
    checkTitle: 'Check the operational path',
    checks: [['Collect', 'Validate device and service data'], ['Investigate', 'Test the actual analyst access'], ['Operate', 'Assign escalation and rule ownership']],
  },
  'xdr-secops-metrics': {
    title: 'Measure a defined cohort, not a moving counter',
    caption: 'Define timestamps, exclusions, and incident regrouping behavior before comparing response performance.',
    nodes: [['Cohort definition', 'Fix the population and time window'], ['Milestones', 'Measure triage and verified response'], ['Improvement', 'Review exceptions and quality']],
    checkTitle: 'Make metrics reproducible',
    checks: [['Population', 'Record filters and regrouping rules'], ['Timing', 'Use explicit milestone timestamps'], ['Quality', 'Review failures, not just averages']],
  },
};

function diagram(id: string, stepId: string, sourceId: string, title: string, caption: string, nodes: readonly NodeText[]): LessonVisual {
  return {
    id, stepId, kind: 'diagram', sourceId, title, caption,
    nodes: nodes.map(([label, detail], index) => ({ id: `node-${index + 1}`, label, detail, column: index, row: 0 })),
    edges: nodes.slice(1).map((_, index) => ({ from: `node-${index + 1}`, to: `node-${index + 2}`, label: '' })),
  };
}

const screenshotPlacements: Record<string, readonly { file: string; stepId: string; title: string; caption: string; alt: string }[]> = {
  'xdr-incident-triage': [{
    file: 'defender-incident-graph.png', stepId: 'evidence-1', title: 'Defender incident graph controls',
    caption: 'Use filters and entity controls to focus the graph. The incident title was removed; generic entity labels remain. Incident cases are a preview experience.',
    alt: 'Defender incident graph with severity and status filters, generic Device and User account nodes, and an alert list.',
  }],
  'xdr-advanced-hunting': [{
    file: 'defender-hunting-filter-fields.png', stepId: 'checkpoint-1', title: 'Advanced hunting: choose a result filter',
    caption: 'The cropped product menu shows schema fields, not result data. Distinguish a result-view filter from changes to the KQL query.',
    alt: 'Add filter menu in Defender advanced hunting listing ActionType, Application, AccountName, ReportId, and other schema fields.',
  }],
  'mdti-hunting': [{
    file: 'defender-hunting-filter-fields.png', stepId: 'evidence-1', title: 'Hunting result filters',
    caption: 'Use the documented portal result controls while reviewing a hunt. Query bounds and indicator-validity joins must still be explicit in KQL.',
    alt: 'Cropped advanced hunting Add filter menu showing only field names and the Add button.',
  }],
  'mdti-indicator-management': [{
    file: 'sentinel-indicator-metadata.png', stepId: 'evidence-1', title: 'Indicator metadata controls',
    caption: 'Confidence, revocation, TLP, and relationships are independent metadata. A confidence value is not an authorization to block.',
    alt: 'Empty Sentinel STIX metadata fields for revoked status, confidence, traffic light protocol, severity, and relationships.',
  }, {
    file: 'sentinel-ingestion-rule-controls.png', stepId: 'checkpoint-1', title: 'Ingestion rule: conditions and actions',
    caption: 'The source value is irreversibly masked. Review the conditions before extending validity; an ingestion edit is not a blocking action.',
    alt: 'Sentinel ingestion rule controls with a masked source value, confidence condition, validity action, tag, and status.',
  }],
};

export function withLessonVisuals(lesson: Lesson): Lesson {
  const plan = plans[lesson.id];
  if (!plan) return lesson;
  const sourceId = lesson.sourceIds[0];
  if (!sourceId) throw new Error('A visual requires a registered primary source.');
  const screenshots: LessonVisual[] = (screenshotPlacements[lesson.id] || []).map((placement) => {
    const asset = media.find((item) => item.file === placement.file);
    if (!asset) throw new Error('Screenshot has no privacy-reviewed media record.');
    return {
      id: placement.file.replace(/\.png$/u, ''), stepId: placement.stepId, kind: 'screenshot',
      title: placement.title, caption: placement.caption, alt: placement.alt,
      sourceId: asset.sourceId, src: `/training-media/${asset.file}`, capturedAt: asset.reviewedAt,
      provenance: 'public-documentation-redacted',
    };
  });
  return {
    ...lesson, revision: lesson.revision + 1,
    sourceIds: [...new Set([...lesson.sourceIds, ...screenshots.map((visual) => visual.sourceId)])],
    visuals: [
      ...(lesson.visuals || []),
      diagram(`${lesson.id}-concept`, 'summary', sourceId, plan.title, plan.caption, plan.nodes),
      diagram(`${lesson.id}-checks`, 'checkpoint-1', sourceId, plan.checkTitle,
        'Use these checks to qualify the operational decision; retain evidence and uncertainty.', plan.checks),
      ...screenshots,
    ],
  };
}
