import type { SiteConfig } from '../shared/contracts';
import { PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import { PageLink } from './routing';

function Operator({ config }: { config: SiteConfig | null }) {
  return <p><strong>Operator:</strong> {config?.operatorName || '@oguzhanf'}. {config?.contactUrl
    ? <a href={config.contactUrl} target="_blank" rel="noopener noreferrer">Private contact channel</a>
    : 'Contact information is currently unavailable.'}</p>;
}

export function TermsPage({ config }: { config: SiteConfig | null }) {
  return <article className="policy">
    <p className="eyebrow">Participation policy / version {TERMS_VERSION}</p>
    <h1>Terms of participation</h1>
    <Operator config={config} />
    <h2>1. Purpose and eligibility</h2>
    <p>Security Resource Kit is an independent educational project, not a Microsoft service, certification, or endorsement. To register, you must be at least 18, be authorized to agree to these terms, and use the site lawfully. An account does not verify your employment or professional status.</p>
    <p>Registration is free. A registered account and an active signed-in session are required to access training topics, references, and discussions. The public landing page, reduced topic outline, participation/privacy policies, and private contact form are available without sign-in.</p>
    <h2>2. Authorized practice only</h2>
    <p>Use lessons in systems you own or are explicitly authorized to test. Training is not permission to access another system. You remain responsible for organizational approval, change control, applicable law, and validating advice against the current product and your environment.</p>
    <h2>3. Discussion contributions</h2>
    <p>Approved contributions are visible to signed-in members. Post only material you are authorized to share. Do not submit credentials, live tokens, personal data about others, customer data, confidential Microsoft or employer information, unredacted incident evidence, abusive material, or copyright-infringing content. Use synthetic examples. Do not impersonate Microsoft, another learner, or an official support channel.</p>
    <h2>4. Accounts and access</h2>
    <p>Use an available Microsoft or GitHub account sign-in, or an optional passkey. Keep control of linked provider accounts and maintain a backup sign-in method. The site does not store passwords or offer email-based recovery. Provider account recovery and organizational access policies remain with the provider or your organization. Loss of every usable sign-in method can make a learner account unrecoverable. Do not share an account, automate abuse, bypass rate limits, or interfere with the service. The operator may restrict participation for violations, security incidents, or legal obligations.</p>
    <h2>5. Your contributions and moderation</h2>
    <p>You retain rights to your original contributions and grant the operator a nonexclusive license to store, moderate, and display them for this community. Public display ends when a contribution is removed; provider backups may persist for their retention period. Moderators may decline, hide, or remove contributions. Use the private contact channel to appeal or report a sensitive issue, not a public discussion.</p>
    <p>Questions, page comments, and replies are pending until reviewed; only the personal site owner's initial announcements can publish immediately. A course forum and its attached page address the same stored conversation; lesson discussions open separately from lesson screens. Replies retain their original parent and are limited to 16 levels; unavailable ancestors also make their descendants unavailable. Removing a contribution erases its text and title, while an anonymous structural placeholder may preserve other members' existing replies.</p>
    <h2>6. Content, availability, and responsibility</h2>
    <p>Content and the service are provided without a promise of completeness, fitness for a particular system, continuous availability, or certification credit. Sources, licenses, and product behavior can change. To the extent permitted by applicable law, the operator is not liable for reliance on educational material or service interruption. Nothing excludes rights or liabilities that cannot legally be excluded. Source documents remain subject to their publishers' terms.</p>
    <h2>7. Data, changes, and ending participation</h2>
    <p>The <PageLink pageId="privacy">privacy notice</PageLink> explains account data and host processing. You can export your account data and delete your account in My account after a recent sign-in. Deleting the learner account does not delete a linked Microsoft or GitHub account or automatically revoke the provider's authorization grant. Material policy revisions require renewed acceptance before further participation. Stop participating if you disagree; contact the operator privately for unresolved requests.</p>
  </article>;
}

export function PrivacyPage({ config }: { config: SiteConfig | null }) {
  return <article className="policy">
    <p className="eyebrow">Privacy notice / version {PRIVACY_VERSION}</p>
    <h1>Privacy Notice</h1>
    <Operator config={config} />
    <h2>What the application stores</h2>
    <p>The site stores your chosen public handle; a random account ID; linked sign-in provider names, hashes of verified provider identity identifiers, and link times; optional passkey public keys, credential IDs, device/backup metadata, and counters; consent versions and acceptance times; diagnostic answers and completion records; discussion contributions; and reports you submit. Microsoft and GitHub supply verified identity information during sign-in; the application does not retain provider access/refresh tokens, names, or email addresses, and does not match accounts by email. Registration does not require your real name, email, employer, passwords, or biometric data. The private contact form stores your message and, only if supplied, a reply email. Passkey verification stays with your device or credential provider; this application receives no fingerprint or facial image.</p>
    <h2>Why it is used</h2>
    <p>Data supports sign-in, learning progress, policy acceptance, member discussions, abuse prevention, moderation, and responding to private requests. Handles and approved contributions are visible to signed-in members. Quiz progress, pending contributions, reports, contact requests, and account records are not available to other learners. Only authorized moderators can review private contact messages and reply addresses.</p>
    <h2>Cookies and browser storage</h2>
    <p>Essential, HttpOnly cookies hold an opaque session identifier and short-lived authentication-flow identifiers. Production session and passkey-flow cookies require HTTPS and SameSite=Strict. The separate account-sign-in flow cookie uses SameSite=Lax so the provider can return to the site; it cannot access member content. Sessions expire after eight hours and sign-in challenges after ten minutes. Only hashes of session, state, browser-binding, and nonce identifiers are persisted. A temporary proof-key verifier and registration details are retained for the short-lived provider exchange and removed when the flow is used or expires. No authentication credential or training catalog is stored in browser local storage. The current tab's navigation history may retain unsubmitted quiz choices, scoped to your account and topic revision, so Back and refresh preserve your selections. These drafts give no completion credit and remain on your device until the relevant tab history is discarded.</p>
    <h2>Hosting and anti-abuse services</h2>
    <p>The site uses Cloudflare Workers and D1 storage. Turnstile checks registration and private contact submissions for abuse, including contact sent while signed in. Authenticated discussion comments, questions, and replies have no robot challenge; they still require current consent, security tokens, rate limits, and moderation. These services can process network metadata, including IP addresses, under their own policies. Provider processing may take place in countries other than your own. The application has no advertising or analytics integration and does not sell account data.</p>
    <p>Optional training issue links open a separate public GitHub tracker. They prefill only the topic ID, revision, and subsection ID, not your site identity, answers, or lesson text. Anything you submit there is governed by GitHub's policies and is not deleted by deleting your learner account. Never include tenant/user identifiers, personal screenshots, secrets, or incident evidence. Use private Contact for sensitive reports.</p>
    <p>If you select Microsoft or GitHub sign-in, that provider processes authentication, account selection, and your authorization under its own policies. The site requests identity access only, not mailbox, repository, or tenant-administration access. A provider or employer can restrict sign-in. Unlinking an account here does not automatically revoke the provider's app authorization; manage that separately in the provider account.</p>
    <h2>Retention</h2>
    <p>Account data remains until you delete the account or the operator lawfully removes it. Account deletion removes active account records, linked provider identities, passkeys, sessions, consent records, progress, contribution text and titles, associated reports, and linked contact requests. Anonymous post IDs and original thread/parent relationships may remain to preserve other members' replies, without your handle, author identity, body, or title. Deleted pending or hidden ancestors remain unavailable and do not reveal their branches. Expired sessions, authentication flows, and salted throttling buckets are purged by the daily maintenance job and can remain until the next successful run. Moderation audit entries and private contact requests are removed after 90 days. Deleting an account removes its identity from remaining audit entries. Deleted data may remain in provider backups until those backups expire.</p>
    <h2>Your controls</h2>
    <p>Use My account after signing in to export data, link or unlink provider accounts, add an optional backup passkey, revoke sessions, or delete the account. Sensitive actions require a sign-in within five minutes, and you cannot remove your last available sign-in method. Use the private operator contact channel for access, correction, appeals, legal rights, or sensitive reports. Do not disclose personal account details in discussions.</p>
    <p>You can also change your public site handle to an available handle in My account. It is independent of a linked provider's login and does not change your account identity or transfer another account's records. Administrator training edits retain reviewed content revisions and change reasons as publication history; deleting an editor's account removes its account reference from those records.</p>
    <h2>Changes and contact</h2>
    <p>Material changes to data use require a revised notice and renewed acceptance before participation. Use the operator's private contact channel for questions about this notice or your account data.</p>
  </article>;
}
