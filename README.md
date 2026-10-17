# Security Resource Kit

Project source and issue tracking: [oguzhanf/security-resource-kit](https://github.com/oguzhanf/security-resource-kit). This is the source repository for the Cloudflare-hosted training site, not a separate feedback-only repository.

Technical training for security professionals working at Microsoft and with Microsoft technologies elsewhere. The interface uses compact Resource Kit documentation typography and a left-hand navigator. Created for **@oguzhanf**.

Reference text uses Verdana at 12 px, with bold headings at 125%/110%, following Microsoft-authored Windows 2000 Resource Kit documentation. Navigation and window controls use Tahoma; code uses Courier New. UI text uses descriptive technical headings, not promotional taglines.

The editorial rule is enforced by tests: **the gist is at most 100 words**. Evidence, operational checkpoints, and exercises are separate. Level 400/500 is a target depth, not an official Microsoft course designation or certification.

Three courses are published: six Agent Identity lessons, eight Microsoft Defender Threat Intelligence lessons, and seven Microsoft Defender XDR SecOps lessons. The 21 lessons include 42 diagnostic questions, 21 application questions, practical exercises, 42 accessible diagrams, and four privacy-reviewed product screenshots. Workload Identity, broader Detection & Response, Azure Authorization, and Agent & Tool Security remain planned.

The Defender TI course covers the August 1, 2026 standalone retirement and E5/XDR/Sentinel entitlement, formerly premium capabilities, Graph TI reads, entity investigations, passive DNS, intelligence-led hunting, Sentinel indicator lifecycle, and third-party IOC/TI access. It distinguishes product inclusion from application permissions, preview availability, workspace access, ingestion charges, and redistribution rights. HTTP/KQL examples use synthetic artifacts or explicit URI templates, never customer credentials or live incident data.

## Run and verify

Defender XDR SecOps covers incident triage, entity/process timelines, bounded advanced hunting, custom detection release, authorized response and Action center verification, operational readiness, and reproducible metrics. Preview incident cases and documented timing/automation discrepancies are identified explicitly.

Use Node 22.12 or newer and the committed lockfile.

| Task | Command |
| --- | --- |
| Restore dependencies | `npm ci` |
| Lint | `npm run lint` |
| Type-check browser, Worker, and tests | `npm run typecheck` |
| Build production assets | `npm run build` |
| Unit tests | `npm test` |
| One test file | `npm test -- security.test.ts` |
| One test case | `npm test -- security.test.ts -t "hashes tokens"` |
| Browser / API integration | `npm run test:e2e` |
| One browser scenario | `npm run test:e2e -- --grep "verified passkeys"` |
| Current source fingerprints | `npm run sources:check` |
| Reproduce approved screenshot crops/masks | `npm run media:prepare` |
| Combined code checks | `npm run check` |

If the browser test reports a missing Chromium executable, install its runtime once with `npx playwright install chromium`. Integration tests use virtual WebAuthn authenticators and a dedicated `.wrangler\e2e-state` database. The test runner starts and stops its isolated Worker; it does not deploy or install a hosting service.

`npm run dev` is an explicit development command, not the hosting mechanism. **Deployment is cloud-only**, through an authenticated Cloudflare account. See [HOSTING.md](HOSTING.md).

## Architecture

```text
Browser: React + catalog-driven navigation and lesson renderer
  |-- static assets --> Cloudflare Workers Assets / dist
  |-- /api/* --------> Hono Worker --> Cloudflare D1
                              |-- passkeys, hashed sessions, consent
                              |-- versioned progress, moderated discussions
Daily Worker Cron ------------|-- Microsoft documentation fingerprints
                              |-- expired-data cleanup
Daily GitHub source check ------> review issue, never automatic lesson edits
```

The browser, API, passkey RP, and discussions share one HTTPS origin. Public static assets remain independently served. API requests and member page routes pass through the Worker; anonymous member-page requests redirect to the landing page. Source checks are informational, not a substitute for a technical review.

`shared\catalog.ts` is the server-only course model. The browser obtains it from `/api/catalog` only after authenticated session and policy checks. Public JavaScript contains types and rendering code, not lesson text, questions, answers, or source URLs. `/api/outline` exposes only top-level track ID, title, and status for the reduced visitor tree. A lesson belongs to a `trackId`; available tracks drive navigation, routes, ordering, prerequisites, and discussion identities.

Registration is free and sign-in is required for topics, references, discussions, and progress. Only the landing page, reduced tree, sign-in/registration flow, terms/privacy policies, and private contact form are available to visitors. Signed-in progress is graded on the server and keyed by account, lesson ID, and revision. Incorrect diagnostic answers do not block the summary for a signed-in learner. Questions are training material, not a certification exam.

Every topic follows the same Next/Back sequence: separate pre-topic question pages, the summary, individual checkpoint/evidence/example pages, the exercise, separate application questions, and finally individual answer and exercise reviews. No scores, correctness feedback, or exercise solutions appear before that final review. Unanswered questions disable Next; failed record saves do not advance. Step URLs are bookmarkable, and per-tab browser history preserves unsubmitted choices scoped to the account, topic, and revision. It stores no completion flags. Completing the application check records server credit; Finish topic closes the review and exposes the next topic's preparation. The final topic reports module completion only from all current-revision server records.

## Add or update training

The tree exposes every subsection with the same preparation/application gates as the player. Finishing a topic collapses its subsection branch; completing an area also collapses its course branch. Reopening a completed topic shows its completion/contents page rather than restarting preparation. Area links always open the full topic table, with expandable subsection contents. Home and Topics list every published training area.

1. Verify the current public primary evidence. Register new source IDs and approved HTTPS upstreams in `shared\source-registry.json`. Both source fetchers use the fixed host/path rules in `shared\source-allowlist.json`: the official Entra repository and the reviewed Microsoft Learn Defender XDR, Graph, Sentinel, and Partner Center announcement paths. Learn upstreams request `accept=text/markdown`; Graph references also pin the API version. Extend the allowlist explicitly for a new primary source.
2. Add a track definition or change its status to `available`, then add lessons with the matching `trackId`. Stable lesson and track IDs preserve discussion and progress relationships.
3. Each lesson needs an objective, a <=100-word gist, at least two scenario-first diagnostic questions, an application check, feedback on every choice, checkpoints, evidence, an exercise, and a real review date. Keep each prose nugget and individual answer review within 100 words. `shared\lesson-flow.ts` generates the complete question/content/review sequence for every lesson; do not add an all-at-once or immediate-feedback exception. Reference registered source IDs. Mark conflicting evidence with `documentationConflict: true` so the member-only References page lists it with its lesson. Optional `codeExamples` specify title, language, code, note, and source ID; each renders on its own page as escaped plain text.
4. For a material lesson change, increment `revision` and update `reviewedAt` after the technical review. Existing signed-in history remains in D1; the current revision needs a new learning record.
5. After reviewing an upstream change, approve only the affected IDs: `npm run sources:approve -- identities`. This updates fingerprints, not lesson content or review dates. Commit the reviewed content and baseline together.

The Worker checks the registered sources daily at **06:17 UTC**. A failed fetch is recorded as `unavailable`; changes are recorded as `changed`. Checks older than 48 hours are flagged as unverified, and lesson reviews older than 45 days get a separate warning. GitHub's auxiliary source-review workflow opens or updates an issue on verification failure.

### Visual nuggets and safe screenshots

`shared\content-schemas.ts` validates the same reusable Lesson interface in API records and administrator edits; do not build individual topic components. Attach `Lesson.visuals` by stable `stepId` (`summary`, `checkpoint-1`, `evidence-1`, etc.). Diagram records contain plain-text nodes with unique grid positions and directed edges; the shared `LessonVisuals` component renders accessible SVG with a text description. Screenshot records contain an approved local PNG path, useful alt text, primary source ID, review date, provenance, and a teaching caption. Never attach answer-revealing visuals to unanswered preparation/application pages. `shared\courses\lesson-visuals.ts` supplies the initial course visual plans; new courses can declare visuals directly in their Lesson records.

The initial screenshots are cropped and irreversibly masked Microsoft Learn product images, not customer-tenant captures. `shared\training-media.json` records source/output fingerprints, crop/mask rectangles, attribution, and the privacy review. `npm run media:prepare` rejects changed source/output bytes, decodes in memory, removes metadata, and writes only approved pixels to `public\training-media`. Visually review final files before publication. Never put raw portal captures, browser profiles, storage state, tenant IDs, user/device names, emails, avatars, live indicators, or incident evidence in public assets, Git, or issues. Tenant capture requires a separately authenticated lab browser and explicit pixel-level review; cropping/blurring alone is not an automatic privacy guarantee.

### Administrator editing and corrections

The pinned personal GitHub owner sees **Edit this nugget** on authored lesson steps and **Training content** in Site management. The same structured editor handles every topic, question, example, exercise, and visual, validates content, and supports a visual preview. Publishing requires fresh site authentication, CSRF, explicit technical/privacy review confirmation, and a reason. The server increments the revision and sets the review date. D1 `lesson_content` overrides a source lesson at the same or a newer revision; grading and authenticated catalog reads use that version. A strictly newer source revision supersedes an older override. `lesson_content_history` records reviewed snapshots/reasons. Export reviewed edits into the source definition before intentionally superseding them in code; never reuse a revision for different content.

Each nugget links to Issues in the public project repository, `oguzhanf/security-resource-kit`, with only lesson ID, revision, and step ID prefilled. No site identity, answers, tenant data, or full lesson text is copied automatically. GitHub is separate from site sign-in. Private security/privacy reports belong in Contact.

## Accounts and community

Accounts can use configured Microsoft or GitHub sign-in, or an optional passkey. Social sign-in uses server-side authorization-code exchanges, S256 PKCE, provider/browser-bound one-use state, and verified immutable identity identifiers. Microsoft ID tokens require signature, audience, tenant/issuer, signing-key issuer, lifetime, and nonce validation. GitHub sign-in requests no additional OAuth scopes and rechecks the authenticated user ID. Provider tokens, names, and email addresses are not retained.

GitHub is listed first; passkey registration and sign-in remain available. **Site management** is a separate protected area for the personal GitHub account `oguzhanf` (immutable GitHub ID `8750972`), not `oguzhanf_microsoft` or a matching public handle. `/api/auth/me` returns its top-bar link only when the live account is linked to that verified identity and has current consent. Every management HTML/API request repeats the owner check; knowing the URL or having the generic moderator role does not grant access.

The management area includes action shortcuts, training content editing/history, forum/announcement links, discussion review, private requests, bounded account/reference lists, and contribution review history. Discussion review filters pending/reported/published/hidden records with private ancestor context. Private records and actions require authentication within five minutes. A linked passkey can authenticate the same owner account; it cannot grant management access to a different account. Removing the owner's GitHub link removes management access.

Public site handles are independent of provider logins: signing in with GitHub does not rename the handle selected during registration. My account allows a fresh-authenticated, CSRF-protected change to an available handle without changing identity or progress. A collision never merges accounts or transfers a handle. My account and forums link the owner to Site management so moderation is discoverable without a generic moderator role.

Registration still requires a public handle, explicit current policy acceptance, and production Turnstile. Existing learners link a provider from My account after a recent sign-in; there is no automatic email/handle merge. Removing a method requires a recently authenticated owner and at least one other available method. Recovery belongs to the linked identity/credential provider; no site password, email-reset, employer verification, advertising, or analytics integration is implemented.

`/contact` is a private, Turnstile-protected operator channel. It accepts a bounded message and an optional reply email; these are never visible in discussions or to other learners. Authorized moderators can review and resolve requests in My account. The daily maintenance job removes contact requests after 90 days. Contact requests sent while signed in are included in account exports and removed with the account.

Every published page has a member-only stored conversation. Non-lesson pages embed their attached discussion; lesson screens do not. Lesson discussions open separately in the corresponding course forum. The central **Discussions** section groups all published catalog tracks, Site discussions, and Announcements. Course overviews and lessons map to their track's forum; other published pages map to Site discussions. Attached page discussions have stable `page-<pageId>` thread IDs: opening one from its page link or forum reads the **same stored conversation**, not a copy. Browser links use ``threadPageId(lesson.trackId, `page-${lesson.id}`)``. Members can also create an independent question with a 5–160-character title and a 10–2000-character initial post. Category filtering searches loaded titles only. The index lists a member's latest accessible contributions or direct replies, including moderation status, without exposing inaccessible ancestor branches.

Authenticated comments, questions, and replies do **not** use Turnstile. They retain same-origin JSON/custom-header checks, CSRF, current versioned consent, shared account/network rate limits, control/secret rejection, and inert plain-text rendering. Contributions are **pending until reviewed**. Only the personal GitHub site owner can create an announcement; creation requires recent authentication, publishes that root immediately, and records its review. Moderator roles and public handles cannot create announcements. All announcement replies, including the owner's, remain pending by default.

Reply relationships are immutable. Server depth is limited to 16 (roots are depth 0); an over-depth reply fails explicitly rather than being truncated or moved. Root posts and independent threads paginate 30 at a time, newest first. Each post's direct replies paginate 30 at a time, oldest first; expand each branch to load its children. Visual indentation stops at six levels on desktop and two on mobile, while explicit levels and parent links preserve deeper relationships. A post is available only when **every ancestor** is published, is the viewer's own pending/hidden contribution, or is an eligible anonymous removed-parent placeholder. Hidden branches cannot receive new replies. Publishing a child never bypasses an unavailable parent. Reports obey the same visibility boundary; moderation queues include private thread and ancestor context.

Migration `0004_threaded_discussions.sql` is additive: it does not rebuild `comments`, replace UUIDs, or cascade-delete reports. Existing bodies, statuses, review fields, report references, and audit history are preserved; legacy direct inserts still become page roots. It adds thread/node metadata and a nullable initial-post title. Account exports include thread, category, parent, depth, and title relationships. Removal clears the contribution text/title. Account deletion physically deletes that member's content and identity, but anonymous topology retains other members' original reply context. A deleted pending/hidden ancestor remains a visibility barrier; deletion cannot make a private branch public. Empty removed branches are pruned transactionally without changing any remaining post's parent, and removed leaves are not displayed. Apply all local migrations before running a development Worker; production migration and Worker-first `/discussions` and `/discussions/*` configuration must remain synchronized.

Moderator access is never granted to the first registrant, a provider claim, or a chosen name. After registering and signing in through your own real account or passkey, verify the account ID in your own export and use the authenticated operator command described in [HOSTING.md](HOSTING.md).

Public participation fails closed until the responsible operator, private contact channel, operator policy approval, production Turnstile keys, exact HTTPS origin/RP ID, and rate-limit salt are configured. Policy approval is the operator's launch decision, not a certification of legal compliance. The production widget is hostname-restricted and uses managed verification; do not replace it with testing keys or bypass verification for live accounts.

See [SECURITY.md](SECURITY.md) for implemented boundaries and operational requirements.
