import registry from './source-registry.json' with { type: 'json' };
import type { Lesson, Track } from './content-types';
import { defenderThreatIntelligenceLessons } from './courses/defender-threat-intelligence';
import { defenderXdrSecopsLessons } from './courses/defender-xdr-secops';
import { withLessonVisuals } from './courses/lesson-visuals';
export type { Choice, Question, Lesson, Track } from './content-types';
export { wordCount, grade } from './learning-utils';

export const sources = registry;

export const lessons: readonly Lesson[] = ([
  {
    id: 'identity-model',
    trackId: 'agent-identity',
    title: 'Agent Identity Objects',
    shortTitle: 'Agent identity objects',
    level: 400,
    minutes: 4,
    revision: 1,
    reviewedAt: '2026-10-06',
    objective: 'Distinguish the credential holder, acting identity, and accountable human.',
    gist: 'An Entra agent identity is a specialized, tenant-local service principal, not a renamed app registration. Its parent blueprint holds credentials and obtains tokens for it. The agent identity carries its own permissions and audit identity; a sponsor supplies human accountability. An optional agent user account is a separate, paired object for systems requiring a user. Model these objects separately. A friendly display name proves nothing. Inventory the object type, parent relationship, granted access, and sponsor before deciding which controls apply.',
    prerequisites: [],
    tags: ['Entra', 'service principal', 'blueprint', 'sponsor', 'agent user'],
    sourceIds: ['identities', 'principals'],
    preflight: [
      {
        id: 'credential-holder',
        scenario: 'An engineer proposes adding a client secret directly to each of 40 agent identities.',
        prompt: 'Which object actually holds the authentication material?',
        correct: 1,
        sourceId: 'identities',
        choices: [
          { text: 'Each child agent identity', feedback: 'The child is the acting identity, but does not hold its own credentials.' },
          { text: 'The parent agent identity blueprint', feedback: 'Correct. The blueprint obtains tokens on behalf of its child identities.' },
          { text: 'The human sponsor', feedback: 'Sponsorship records accountability. It is not an authentication credential.' },
          { text: 'The optional agent user account', feedback: 'That is a separate object for user-only resources, not the blueprint credential store.' },
        ],
      },
      {
        id: 'named-application',
        scenario: 'A standard enterprise application has been renamed "Research Agent".',
        prompt: 'Does the new name establish an Entra agent identity?',
        correct: 2,
        sourceId: 'principals',
        choices: [
          { text: 'Yes; display name controls the identity type', feedback: 'Names are mutable labels, not an identity type or trust boundary.' },
          { text: 'Yes; any autonomous workload is automatically converted', feedback: 'Workload behavior does not convert the underlying directory object.' },
          { text: 'No; inspect the object type and blueprint relationship', feedback: 'Correct. Agent identities have distinct platform behavior; a renamed application does not gain it.' },
          { text: 'Only if the application has tenant-wide permissions', feedback: 'Grant breadth does not determine the object type.' },
        ],
      },
    ],
    application: [
      {
        id: 'mailbox-object',
        scenario: 'An agent needs its own mailbox rather than delegated access to a human mailbox.',
        prompt: 'Which identity design is appropriate?',
        correct: 0,
        sourceId: 'identities',
        choices: [
          { text: 'An agent identity with a paired agent user account', feedback: 'Correct. Keep the paired user object distinct from the primary agent identity.' },
          { text: 'A shared human administrator account', feedback: 'That conflates human and agent accountability and introduces inappropriate privileges.' },
          { text: 'A display-name change on the blueprint', feedback: 'A name change does not supply a user object or mailbox.' },
          { text: 'Put mailbox credentials on the child service principal', feedback: 'Child agent identities do not hold their own authentication credentials.' },
        ],
      },
    ],
    checkpoints: [
      'Map blueprint -> agent identity -> optional paired user account.',
      'Record object IDs, sponsor, owners, and effective permissions separately.',
      'Treat the blueprint credential as a shared compromise surface.',
    ],
    evidence: [
      { title: 'Service principal classification', text: 'Legacy agents can use ordinary application service principals. Do not assume they have agent-specific sponsorship, delegation, or lifecycle behavior.', sourceId: 'principals' },
      { title: 'Tenant boundary', text: 'The child agent identity remains single-tenant. A multitenant blueprint can create distinct tenant-local children; it does not make one child cross-tenant.', sourceId: 'identities' },
    ],
    exercise: {
      title: 'Draw the inventory',
      prompt: 'For a mailbox-enabled agent, draw the three directory objects and identify who owns credentials, permissions, and business accountability.',
      expected: 'Blueprint: credentials. Agent identity: primary permissions and audit identity. Paired user: user-only resource access. Sponsor: accountable human or group, not another credential.',
    },
  },
  {
    id: 'blueprint-boundaries',
    trackId: 'agent-identity',
    title: 'Agent Identity Blueprint Security',
    shortTitle: 'Blueprint security',
    level: 500,
    minutes: 5,
    revision: 1,
    reviewedAt: '2026-10-06',
    objective: 'Choose blueprint and child counts from trust boundaries, not replica counts.',
    gist: 'Blueprint count is a security decision. A compromised blueprint credential can reach its children, so separate blueprints where credentials and runtimes must be isolated. Inside one trust boundary, use distinct agent identities when permission, attribution, or lifecycle must differ. Replicas alone do not justify new identities. Nor does a separate child contain compromise of a shared blueprint. Prefer managed-identity federation or certificates to production client secrets. Document the containment scope before choosing the object count.',
    prerequisites: ['identity-model'],
    tags: ['trust boundary', 'blast radius', 'federation', 'managed identity', 'architecture'],
    sourceIds: ['architecture', 'protocols'],
    preflight: [
      {
        id: 'shared-blueprint',
        scenario: 'Two isolated business units have separate runtimes but share one blueprint credential.',
        prompt: 'What undermines their intended isolation?',
        correct: 1,
        sourceId: 'architecture',
        choices: [
          { text: 'Different display names', feedback: 'Labels do not establish or remove cryptographic isolation.' },
          { text: 'The shared credential can impersonate both sets of children', feedback: 'Correct. A common blueprint creates a common credential compromise surface.' },
          { text: 'Distinct child object IDs', feedback: 'Distinct identities improve attribution, but do not isolate a shared parent credential.' },
          { text: 'Separate sponsors', feedback: 'Human accountability is important, but does not contain credential compromise.' },
        ],
      },
      {
        id: 'replica-count',
        scenario: 'One logical agent scales from two replicas to twenty without changing permissions or runtime boundaries.',
        prompt: 'What should drive adding identities?',
        correct: 2,
        sourceId: 'architecture',
        choices: [
          { text: 'Always one identity per process', feedback: 'Process count is not, by itself, an identity boundary.' },
          { text: 'Always one blueprint per replica', feedback: 'That adds objects without establishing an additional trust boundary.' },
          { text: 'Attribution, permission, and lifecycle requirements', feedback: 'Correct. Logical security responsibilities matter more than horizontal scale.' },
          { text: 'The number of prompt tokens', feedback: 'Model context size does not determine directory identity boundaries.' },
        ],
      },
    ],
    application: [
      {
        id: 'isolate-production',
        scenario: 'Development and production agents must not share credential compromise risk.',
        prompt: 'Which design expresses that requirement?',
        correct: 0,
        sourceId: 'architecture',
        choices: [
          { text: 'Separate blueprints and isolated authentication material', feedback: 'Correct. Isolate the parent credential surface, not just the child labels.' },
          { text: 'One blueprint; name the children dev and prod', feedback: 'Names do not prevent the parent from impersonating either child.' },
          { text: 'One child; switch its display name during deployment', feedback: 'That also collapses attribution and lifecycle independence.' },
          { text: 'A shared secret stored in two different config files', feedback: 'Copies of the same secret still create the same compromise boundary.' },
        ],
      },
    ],
    checkpoints: [
      'Partition blueprint credentials along actual runtime and trust boundaries.',
      'Separate logical agents for permission, attribution, or lifecycle needs.',
      'Prefer federation; do not introduce a long-lived production client secret for convenience.',
    ],
    evidence: [
      { title: 'Blueprint versus child isolation', text: 'Child permissions can differ under one blueprint. That does not make the children independent of the parent authentication material.', sourceId: 'architecture' },
      { title: 'Credential choice', text: 'Microsoft recommends managed identities for supported deployments and warns against production blueprint client secrets. Use approved SDKs for the exchange.', sourceId: 'protocols' },
    ],
    exercise: {
      title: 'Threat-model the parent',
      prompt: 'List what an attacker holding one blueprint credential could reach. Compare that list with the intended incident-containment boundary.',
      expected: 'Map all children and their effective downstream permissions. Split the blueprint where that combined reach exceeds the intended boundary; a separate child alone is insufficient.',
    },
  },
  {
    id: 'token-paths',
    trackId: 'agent-identity',
    title: 'Agent Identity Authentication',
    shortTitle: 'Authentication and tokens',
    level: 500,
    minutes: 5,
    revision: 1,
    reviewedAt: '2026-10-06',
    objective: 'Determine who is acting and which resource a token can legitimately reach.',
    gist: 'An agent can act autonomously, on behalf of a human, or through a paired agent user account. Those paths have different token subjects and policy targets. The blueprint participates in token exchange; it is not automatically the downstream subject. Validate issuer, audience, lifetime, signature, and required authorization at the resource. Identify the actor as well as the subject. Decoding a JWT is not validation. Use Microsoft-supported agent identity SDKs rather than hand-rolling the multi-stage exchanges.',
    prerequisites: ['identity-model'],
    tags: ['OAuth', 'OBO', 'claims', 'audience', 'issuer', 'token validation'],
    sourceIds: ['protocols', 'claims', 'access'],
    preflight: [
      {
        id: 'delegated-subject',
        scenario: 'A signed-in analyst asks an agent to read the analyst\'s own data through an on-behalf-of flow.',
        prompt: 'Who is the downstream token subject?',
        correct: 1,
        sourceId: 'access',
        choices: [
          { text: 'Always the blueprint', feedback: 'The credential holder is not necessarily the downstream token subject.' },
          { text: 'The analyst, with the agent identified as the caller', feedback: 'Correct. Delegated access represents the user; preserve agent attribution too.' },
          { text: 'The sponsor', feedback: 'Sponsorship does not make the sponsor the delegated user.' },
          { text: 'Every child under the blueprint', feedback: 'A token does not represent all sibling identities.' },
        ],
      },
      {
        id: 'wrong-audience',
        scenario: 'A valid token issued for resource A reaches resource B.',
        prompt: 'What is the correct security decision?',
        correct: 0,
        sourceId: 'access',
        choices: [
          { text: 'Reject it; acquire a token for B through the supported flow', feedback: 'Correct. A valid signature does not override an audience mismatch.' },
          { text: 'Accept it if the tenant ID matches', feedback: 'Tenant membership does not authorize a token for the wrong resource.' },
          { text: 'Rewrite the audience claim locally', feedback: 'Changing a signed claim invalidates the signature and creates no authorization.' },
          { text: 'Accept it if the agent has a sponsor', feedback: 'Accountability metadata does not validate token audience.' },
        ],
      },
    ],
    application: [
      {
        id: 'autonomous-subject',
        scenario: 'A scheduled agent job accesses a resource without a signed-in human.',
        prompt: 'Which subject should the app-only path represent?',
        correct: 2,
        sourceId: 'protocols',
        choices: [
          { text: 'The last person who spoke to the agent', feedback: 'A past conversation is not a current delegated authorization context.' },
          { text: 'The site operator', feedback: 'The training-site operator has no role in the tenant token flow.' },
          { text: 'The agent identity', feedback: 'Correct. Autonomous application access represents the agent, not a human user.' },
          { text: 'The business sponsor by default', feedback: 'A sponsor is accountable, not automatically impersonated.' },
        ],
      },
    ],
    checkpoints: [
      'Name the flow before interpreting the subject.',
      'At the API, validate the token and enforce the required permission.',
      'Correlate subject, caller, blueprint, audience, and request identifiers in authorized telemetry.',
    ],
    evidence: [
      { title: 'Claims are contextual', text: 'The agent claims reference distinguishes blueprint, agent identity, and agent user tokens. Do not assume one claim set describes every exchange stage.', sourceId: 'claims' },
      { title: 'Supported authentication flows', text: 'Agents can serve human-facing experiences while their identity authentication still uses confidential-client exchanges. Direct interactive flows on agent entities are not supported.', sourceId: 'protocols' },
    ],
    exercise: {
      title: 'Annotate a synthetic request',
      prompt: 'Create a synthetic record with subject, actor, issuer, audience, permission, and correlation ID. Mark which fields are validated at the API.',
      expected: 'Validate trusted issuer, intended audience, signature, time bounds, and authorization. Keep attribution separate. Never paste live tokens into this site or public decoders.',
    },
  },
  {
    id: 'permission-inheritance',
    trackId: 'agent-identity',
    title: 'Permission Configuration and Inheritance',
    shortTitle: 'Permission inheritance',
    level: 400,
    minutes: 4,
    revision: 1,
    reviewedAt: '2026-10-06',
    objective: 'Reason about effective access without treating declarations as grants.',
    gist: 'A permission declaration is not consent. Blueprint inheritance can flow consented delegated scopes and application roles to children; direct grants can add access. Reason about effective tokens and resource authorization, not the portal checklist alone. An all-allowed configuration can widen the inherited baseline when future permissions are granted. Constrain parent grants and verify the configuration your tenant actually supports. Review inheritance, direct grants, and non-Graph authorization separately. Removing one direct grant does not prove access disappeared if an inherited path remains.',
    prerequisites: ['identity-model', 'token-paths'],
    tags: ['permissions', 'consent', 'least privilege', 'delegated scopes', 'Graph', 'inheritance'],
    sourceIds: ['inheritance', 'operations'],
    preflight: [
      {
        id: 'declared-grant',
        scenario: 'A blueprint lists a delegated scope in required resource access.',
        prompt: 'What does that declaration prove?',
        correct: 1,
        sourceId: 'inheritance',
        choices: [
          { text: 'All children already possess the scope', feedback: 'Declaration, consent, and inheritance are different decisions.' },
          { text: 'The scope is requested; actual consent and effective access still need verification', feedback: 'Correct. Inspect grants and the effective token, not just requested access.' },
          { text: 'The downstream resource has authorized every operation', feedback: 'Resources still enforce their own authorization requirements.' },
          { text: 'The agent is now a tenant administrator', feedback: 'A requested delegated scope does not assign a directory role.' },
        ],
      },
      {
        id: 'future-grants',
        scenario: 'A blueprint uses all-allowed delegated scope inheritance. An administrator later grants another scope.',
        prompt: 'Which risk should the reviewer anticipate?',
        correct: 0,
        sourceId: 'operations',
        choices: [
          { text: 'The inherited baseline can widen without a new per-child decision', feedback: 'Correct. Constrain the parent grant baseline and verify the supported inheritance configuration.' },
          { text: 'Only the display name changes', feedback: 'This is an authorization change, not a naming change.' },
          { text: 'Existing children are cryptographically isolated from the blueprint', feedback: 'The inheritance relationship remains in place.' },
          { text: 'Every scope requires interactive consent on each child', feedback: 'The purpose of inheritance is to avoid repeated per-child consent.' },
        ],
      },
    ],
    application: [
      {
        id: 'residual-permission',
        scenario: 'A direct child grant is removed, but the same delegated scope remains inherited.',
        prompt: 'What must you verify before declaring access revoked?',
        correct: 2,
        sourceId: 'inheritance',
        choices: [
          { text: 'Only that the direct grant disappeared from one screen', feedback: 'That overlooks the inherited route and issued token state.' },
          { text: 'Only that the child has a new display name', feedback: 'A name change revokes no authorization.' },
          { text: 'Every effective grant path and downstream enforcement', feedback: 'Correct. An inherited grant can preserve access after the direct grant is removed.' },
          { text: 'Whether the sponsor logged out of this training site', feedback: 'Training-site sessions have no relationship to tenant authorization.' },
        ],
      },
    ],
    checkpoints: [
      'Separate requested permissions from consented permissions.',
      'Constrain the inherited baseline and parent grants; review direct child grants too.',
      'Test actual effective access in an authorized nonproduction tenant.',
    ],
    evidence: [
      { title: 'Different configuration surfaces', text: 'Required resource access describes requested permissions. Inheritable permissions define the child baseline. Actual consent remains necessary.', sourceId: 'inheritance' },
      { title: 'Documentation mismatch to verify', text: 'The concept page describes scopes and application roles with all/none patterns; the admin guide describes enumerated delegated scopes. Verify the current Graph schema and tenant behavior rather than assuming these descriptions are equivalent.', sourceId: 'operations', documentationConflict: true },
    ],
    exercise: {
      title: 'Build a grant ledger',
      prompt: 'For one synthetic agent, make four columns: requested, consented, inherited, direct. Derive the effective access you would test.',
      expected: 'List the union of applicable inherited and direct paths, then validate token permissions and resource enforcement. Flag all-allowed inheritance for explicit review.',
    },
  },
  {
    id: 'conditional-access',
    trackId: 'agent-identity',
    title: 'Conditional Access for Agent Identities',
    shortTitle: 'Conditional Access',
    level: 500,
    minutes: 5,
    revision: 1,
    reviewedAt: '2026-10-06',
    objective: 'Select policy targets for each access path and identify what bypasses Entra token issuance.',
    gist: 'Conditional Access follows the access path. Delegated access targets the human; app-only access targets the agent identity or blueprint; an agent user account requires its own targeting. One policy does not automatically cover all three. Evaluation happens at Entra token issuance or refresh, with additional enforcement only where supported. A direct API key bypasses that pipeline. Treat token-exchange exceptions and resource-specific controls explicitly; do not confuse a green policy report with complete runtime containment.',
    prerequisites: ['token-paths', 'permission-inheritance'],
    tags: ['Conditional Access', 'policy', 'API key', 'CAE', 'risk', 'agent users'],
    sourceIds: ['access', 'operations', 'containment'],
    preflight: [
      {
        id: 'paired-user-gap',
        scenario: 'A policy blocks an agent identity. Its paired agent user account has a separate access path.',
        prompt: 'What must you avoid assuming?',
        correct: 1,
        sourceId: 'access',
        choices: [
          { text: 'The two objects have different IDs', feedback: 'They are distinct objects; that part is expected.' },
          { text: 'The agent-identity policy automatically covers the paired user', feedback: 'Correct. Target the relevant subject for each path separately.' },
          { text: 'App-only tokens have a resource audience', feedback: 'Audience still matters for app-only tokens.' },
          { text: 'Policies can be evaluated at token issuance', feedback: 'That is a normal enforcement point, not the mistaken assumption.' },
        ],
      },
      {
        id: 'api-key-gap',
        scenario: 'An agent calls a third-party service directly using that service\'s API key.',
        prompt: 'Will an Entra Conditional Access policy evaluate this API-key request?',
        correct: 0,
        sourceId: 'access',
        choices: [
          { text: 'No; this request bypasses Entra token issuance', feedback: 'Correct. Control the key, service authorization, and network path separately.' },
          { text: 'Yes; the agent has an Entra object', feedback: 'Directory existence does not force arbitrary service calls through Entra.' },
          { text: 'Yes; all HTTP requests are token refreshes', feedback: 'An HTTP request is not necessarily an Entra token request.' },
          { text: 'Only if the display name contains "agent"', feedback: 'Names do not change the authentication pipeline.' },
        ],
      },
    ],
    application: [
      {
        id: 'mixed-policy',
        scenario: 'One agent uses delegated, app-only, and agent-user access to different resources.',
        prompt: 'Which control plan matches those paths?',
        correct: 2,
        sourceId: 'operations',
        choices: [
          { text: 'Only a policy targeting all human users', feedback: 'That does not automatically include the agent identity or paired agent user.' },
          { text: 'Only an agent-identity policy', feedback: 'That does not automatically cover user-subject paths.' },
          { text: 'Explicit policy coverage for each subject, plus controls for non-Entra paths', feedback: 'Correct. Enumerate the access paths rather than assuming one policy covers the whole agent.' },
          { text: 'No policy; the sponsor approves each request', feedback: 'Sponsorship is not a replacement for enforced authorization.' },
        ],
      },
    ],
    checkpoints: [
      'Map each operation to a subject, resource, and policy target.',
      'Use report-only evaluation before enforcing a new policy.',
      'Inventory API keys and other paths outside the Entra pipeline.',
    ],
    evidence: [
      { title: 'Policy requirements', text: 'Check the current Microsoft requirements before deployment. Do not extrapolate human-user licensing or policy targeting to agent-specific controls.', sourceId: 'operations' },
      { title: 'Issued tokens and external credentials', text: 'Blocking future issuance is not proof that already-issued tokens or external credentials have stopped working. Validate at each resource.', sourceId: 'containment' },
    ],
    exercise: {
      title: 'Make a coverage matrix',
      prompt: 'Write one row per access path: subject, audience, credential, policy target, and enforcement point. Add a row for a non-Entra API key.',
      expected: 'Different subjects need explicit policy coverage. The API-key row needs service/key/network controls and cannot be marked protected by Entra Conditional Access alone.',
    },
  },
  {
    id: 'investigate-contain',
    trackId: 'agent-identity',
    title: 'Agent Identity Monitoring and Incident Response',
    shortTitle: 'Monitoring and incident response',
    level: 500,
    minutes: 6,
    revision: 1,
    reviewedAt: '2026-10-06',
    objective: 'Build a defensible incident scope without confusing an acting child with its credential source.',
    gist: 'Start with the acting agent identity, then map its blueprint, siblings, sponsor, grants, and any paired user. Correlate directory sign-ins with downstream resource activity; neither alone is the whole incident. If the blueprint credential is exposed, scope all reachable children. Preserve evidence before approved containment. Block relevant access paths, address compromised authentication material, and verify enforcement against issued tokens and external credentials. Record what stopped, what might still work, and who must make the next decision.',
    prerequisites: ['blueprint-boundaries', 'conditional-access'],
    tags: ['incident response', 'audit logs', 'sign-in logs', 'containment', 'sponsor', 'forensics'],
    sourceIds: ['containment', 'claims', 'principals', 'operations'],
    preflight: [
      {
        id: 'acting-child',
        scenario: 'A resource log shows one child agent performed the suspicious operation.',
        prompt: 'Does that identify the full credential compromise scope?',
        correct: 2,
        sourceId: 'principals',
        choices: [
          { text: 'Yes; sibling identities are always independent', feedback: 'Siblings can share the same blueprint credential surface.' },
          { text: 'Yes; the resource log always contains every token exchange', feedback: 'Downstream logs are not a complete record of identity-provider activity.' },
          { text: 'No; investigate the parent credential and other reachable children', feedback: 'Correct. The acting identity is a starting point, not a complete blast-radius statement.' },
          { text: 'No investigation is needed when a sponsor exists', feedback: 'Accountability does not eliminate compromise risk.' },
        ],
      },
      {
        id: 'issuance-versus-use',
        scenario: 'New token issuance has been blocked during approved containment.',
        prompt: 'What still requires verification?',
        correct: 0,
        sourceId: 'containment',
        choices: [
          { text: 'Already-issued tokens, paired-user paths, and external credentials', feedback: 'Correct. Verify residual access and each downstream enforcement point.' },
          { text: 'Only the page title in the admin center', feedback: 'A visual label is not evidence of blocked access.' },
          { text: 'Nothing; every resource is instantly unreachable', feedback: 'That claims more than the token issuance control proves.' },
          { text: 'Only whether the learner passed this quiz', feedback: 'Training results are not evidence from the incident environment.' },
        ],
      },
    ],
    application: [
      {
        id: 'incident-scope',
        scenario: 'A blueprint credential is suspected compromised, and one of its children also uses a third-party API key.',
        prompt: 'Which response scope is defensible?',
        correct: 1,
        sourceId: 'containment',
        choices: [
          { text: 'Rename the one child shown in the alert', feedback: 'That neither contains the credential nor establishes the reachability surface.' },
          { text: 'Preserve evidence; scope all children and separately contain non-Entra access', feedback: 'Correct. Coordinate authorized containment and validate residual access explicitly.' },
          { text: 'Block a human sponsor and assume the agents stop', feedback: 'The sponsor is not necessarily the runtime token subject.' },
          { text: 'Publish the live token in the page discussion', feedback: 'Never disclose live tokens, tenant evidence, secrets, or restricted internal data here.' },
        ],
      },
    ],
    checkpoints: [
      'Preserve authorized telemetry and a UTC timeline before making changes.',
      'Scope the parent, children, paired users, grants, and non-Entra credentials.',
      'Contain under the organization\'s incident process, then verify residual access.',
    ],
    evidence: [
      { title: 'Directory event selectors', text: 'Agent identity creation can appear as add service principal; blueprint creation can appear as add application. Inspect agentType on initiatedBy and targetResources for agent involvement, and use agentSignIn classification in sign-in telemetry.', sourceId: 'containment' },
      { title: 'Owner and sponsor responsibilities', text: 'Owners administer the technical object; sponsors are accountable for purpose and lifecycle. Bring both into decisions that affect business operation.', sourceId: 'operations' },
    ],
    exercise: {
      title: 'Write the handoff in five lines',
      prompt: 'Using only synthetic data, record: affected identity, parent/siblings, observed resource action, approved containment, and unresolved residual access.',
      expected: 'The handoff names object IDs and UTC evidence, separates observation from inference, identifies the business decision owner, and does not claim complete containment without resource verification.',
    },
  },
  ...defenderThreatIntelligenceLessons,
  ...defenderXdrSecopsLessons,
] satisfies Lesson[]).map(withLessonVisuals);

export const tracks: readonly Track[] = [
  {
    id: 'agent-identity',
    title: 'Agent Identity',
    description: 'Identity boundaries, token paths, policy coverage, and incident response.',
    status: 'available' as const,
  },
  {
    id: 'defender-threat-intelligence',
    title: 'Microsoft Defender Threat Intelligence',
    description: 'E5 availability, Microsoft Graph TI APIs, investigations, hunting, indicator lifecycle, and third-party integrations.',
    status: 'available' as const,
  },
  {
    id: 'defender-xdr-secops',
    title: 'Microsoft Defender XDR SecOps',
    description: 'Incident triage, entity timelines, advanced hunting, custom detections, response actions, operational readiness, and SecOps metrics.',
    status: 'available' as const,
  },
  {
    id: 'workload-identity',
    title: 'Workload Identity',
    description: 'Managed identities, federation, and workload credential boundaries.',
    status: 'planned' as const,
  },
  {
    id: 'detection-response',
    title: 'Detection & Response',
    description: 'Defender, Sentinel, evidence quality, and practical investigations.',
    status: 'planned' as const,
  },
  {
    id: 'azure-authorization',
    title: 'Azure Authorization',
    description: 'Control-plane and data-plane access, RBAC, and effective privileges.',
    status: 'planned' as const,
  },
  {
    id: 'agent-tool-security',
    title: 'Agent & Tool Security',
    description: 'Tool authorization, MCP boundaries, and unsafe trust transitions.',
    status: 'planned' as const,
  },
].map((track) => ({ ...track, lessonIds: lessons.filter((lesson) => lesson.trackId === track.id).map((lesson) => lesson.id) }));

export const pageIds = new Set([
  'home', 'about', 'terms', 'privacy', 'sources', 'roadmap', 'account',
  ...tracks.filter((track) => track.status === 'available').map((track) => `track-${track.id}`),
  ...lessons.map((lesson) => lesson.id),
]);

export function getLesson(id: string): Lesson | undefined {
  return lessons.find((lesson) => lesson.id === id);
}
