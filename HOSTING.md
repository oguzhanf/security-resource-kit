# Permanent cloud hosting

**Target: Cloudflare Workers Assets + a Worker API + D1, in the operator's own Free-plan account.** The site needs no server VM, IIS installation, scheduled Windows process, tunnel, temporary account, or paid plan enrollment.

This repository is prepared for deployment. A public address exists only after authenticated deployment succeeds and its HTTPS health check passes. A local development/test URL is not a deployment.

## Free-plan capacity

Checked against Cloudflare's published documentation on **October 6, 2026**:

| Resource | Included free capacity |
| --- | --- |
| Static asset requests | Unlimited, without application Worker invocations |
| Application Worker requests | 100,000/day |
| Application Worker CPU | 10 ms per invocation |
| D1 reads | 5 million rows/day |
| D1 writes | 100,000 rows/day |
| D1 storage | 5 GB/account total; 500 MB maximum for one Free database |

Official references: `https://developers.cloudflare.com/workers/platform/pricing/`, `https://developers.cloudflare.com/workers/platform/limits/`, `https://developers.cloudflare.com/d1/platform/pricing/`, and `https://developers.cloudflare.com/d1/platform/limits/`.

Quotas are not an uptime promise or a guarantee that a provider will keep a plan unchanged forever. Verify the account's current tier and inspect CPU/usage metrics before opening registration. This project does not upgrade the account, add a payment method, or bypass limits. Static lessons remain independently served; API exhaustion can make account/community operations unavailable.

## First permanent publication

Run from the project root:

```powershell
npm ci
npm run check
npm run test:e2e
npx wrangler login --device --use-keyring --scopes account:read user:read workers_scripts:write d1:write
npm run cloud:setup
npm run deploy
```

Device authorization requires the operator to approve the displayed code in their own Cloudflare account within five minutes. Do not paste passwords, API tokens, or passkey material into chat. On Windows, if secure credential storage reports its native binding missing, install the CLI's pinned user-scoped dependency with `npm install -g @napi-rs/keyring@1.3.0`; ensure your npm global prefix is your user directory, not a shared/admin-owned installation.

`cloud:setup` creates a uniquely named D1 database and writes an ignored `wrangler.production.json`. It does not silently adopt an existing database. For multiple Cloudflare accounts, supply the intended account's ID with `--account-id`; do not deploy to an ambiguous account.

`deploy` applies remote migrations, publishes to the real account, creates a cryptographically random rate-limit salt as a Worker secret, discovers the permanent `workers.dev` address, configures the exact passkey origin/RP ID, redeploys if needed, and verifies the public health/config responses. Visitors see only the free-registration landing page, reduced tree, required policies, and private contact form. Training content and discussions require sign-in. New account registration stays closed until the launch settings are completed.

If your account has no `workers.dev` subdomain yet, Cloudflare may require you to choose one in Workers & Pages before publication. A custom domain is optional and not required for free hosting.

## Open public participation

Before opening accounts:

1. Review the rendered terms and privacy notice, name the responsible operator, and use the site's HTTPS `/contact` route or another working private contact channel. Review applicable legal basis, privacy obligations, processor arrangements, location/transfers, and backup retention. Do not use a discussion as the privacy/security reporting channel.
2. Create a Cloudflare Turnstile widget for the final site hostname. Keep its secret out of source, frontend variables, command arguments, and chat.
3. Set the server secret interactively:

```powershell
npx wrangler secret put TURNSTILE_SECRET_KEY --config .\wrangler.production.json
```

4. Record the operator's actual approval and public widget key:

```powershell
npm run cloud:setup -- --operator-name "Responsible operator" --contact-url "https://your-private-contact-channel.example" --turnstile-site-key "YOUR_PUBLIC_SITE_KEY" --legal-approved
npm run deploy
```

The production API rejects participation if any launch gate is missing. The Turnstile token is verified on the server, including hostname and action. `RATE_LIMIT_SALT` is generated automatically and never written into the production config.

The built-in contact channel stores requests privately in D1. The moderator queue requires a recently authenticated moderator; Cloudflare account administrators also retain access through authenticated D1 tooling. This keeps privacy/security requests available without requiring the sender to register.

Set the final passkey domain **before real learners enroll**. Changing the RP ID later is an identity migration, not a cosmetic URL change; existing passkeys will not automatically move to another domain.

## Bootstrap a moderator

Register and sign in using your own linked Microsoft/GitHub account or optional real passkey on the published site. Export your account data immediately after signing in and verify both the immutable account ID and public handle. Then run:

```powershell
npm run moderator:grant -- --user-id "ACCOUNT_UUID_FROM_YOUR_EXPORT" --handle "your-verified-handle"
```

The command requires authenticated Cloudflare D1 write access and matches **both** ID and handle. A public handle alone is not identity proof. No registrant becomes a moderator automatically.

Sign in again, open My account, and load the moderation queue. New contributions are unpublished until approved. Published reports return to the private moderation queue without letting one report automatically censor a contribution.

If the operator chooses a passkey, it must use a real credential provider. A password, Microsoft Password Manager/Windows Hello PIN, biometric check, security-key confirmation, or identity-provider approval is a personal authentication step; automation must not choose/read it or install a password/reset bypass. Existing-account sign-in does not require creating a site passkey. Grant the moderator role only to the exact verified account ID.

## Existing-account sign-in

Register dedicated provider apps for this site; do not reuse Cloudflare, Graph, CLI, or unrelated application IDs. The UI lists only providers with a configured client ID and server secret. Missing provider configuration does not disable existing passkeys or expose setup instructions to visitors.

The GitHub app must be owned by a **personal account or regular organization**, not an Enterprise Managed User or managed-user organization. GitHub limits managed-owned OAuth apps to members of that enterprise; personal learners can receive GitHub's authorization 404 even when the callback and client ID are correct. The site's public app is owned by the personal `oguzhanf` account. Deployment verifies that the authorization endpoint is reachable without an enterprise session and cancels its verification flow afterward.

| Provider | Application configuration | Exact production callback |
| --- | --- | --- |
| Microsoft | Web application; work/school and personal Microsoft account audience; authorization-code flow; `openid profile` only; no implicit grant, Graph data/admin permissions, or offline access required | `https://security-resource-kit-d71224.filizlibay.workers.dev/api/auth/social/microsoft/callback` |
| GitHub | Dedicated OAuth app; this site's homepage; exact redirect matching, no wildcards or device flow; no additional scopes or repository access | `https://security-resource-kit-d71224.filizlibay.workers.dev/api/auth/social/github/callback` |

Store each provider's ID and secret through the authenticated Worker-secret mechanism:

```powershell
npx wrangler secret put MICROSOFT_CLIENT_ID --config .\wrangler.production.json
npx wrangler secret put MICROSOFT_CLIENT_SECRET --config .\wrangler.production.json
npx wrangler secret put GITHUB_CLIENT_ID --config .\wrangler.production.json
npx wrangler secret put GITHUB_CLIENT_SECRET --config .\wrangler.production.json
npm run deploy
```

These are operator configuration commands, not instructions to learners. Do not place secret values in command arguments, config JSON, browser variables, screenshots, chat, or source. Record/monitor provider-secret expiration and rotate secrets in the same app registration before expiry. Keep provider app IDs stable: replacing an app can change pairwise subjects and requires an identity migration, not an email-based merge. Organization consent/access rules may block a work account even when the site is correctly configured.

Existing passkey learners link a provider in My account after a recent sign-in. Linking and reauthentication are bound to the original live session, including when its Strict cookie is absent from the cross-site callback. Unlinking is local removal, not deletion of the provider account or revocation of its separate app grant. An operator disabling a provider should ensure affected learners retain another usable method.

## Site management

The personal GitHub account `oguzhanf`, immutable GitHub user ID `8750972`, is the only management owner. The Microsoft-managed `oguzhanf_microsoft` identity is deliberately excluded, even if its site handle is `oguzhanf`. There is no first-user promotion, email/handle match, or moderator-role shortcut to this area.

Sign in/register with the personal GitHub identity or link it to an account through the existing recent-authentication workflow. Use an available public handle; handles are distinct from GitHub logins. The server then returns the **Site management** top-bar link. Passkeys remain available and can authenticate this same linked owner account without changing its identity authorization.

The management page provides overview counts, discussion decisions, private-request resolution, recent account records, references, and contribution-review history. Access to private records requires a sign-in within five minutes. No provider token, raw session token, passkey public key, or other user's quiz answers are exposed. Knowledge of the URL is not authorization. Keep the pinned owner ID stable; replacing it is a privileged code/identity change requiring explicit owner authorization.

## Maintenance and recovery

Management includes **Training content**, **Forums and announcements**, and **Content history**, with direct shortcuts to discussion moderation and private requests. Use Discussion review's status selector for pending, reported, published, or hidden posts. The owner does not need the generic moderator role. After five minutes, use **Sign in again** and refresh; management does not relax authorization to keep its UI populated.

Migration `0005_lesson_content.sql`, applied by normal deployment, adds versioned content overrides/review snapshots without changing existing accounts, progress, or discussion topology. Reviewed edits persist across deployments. Export reviewed content before superseding it in source with a strictly newer revision. Include these tables in the normal D1 recovery procedure.

The project source and public correction tracker are in `oguzhanf/security-resource-kit`; lesson links open that repository's Issues and prefill only content coordinates. Sensitive requests remain private. Product image publication is limited to fingerprinted privacy-reviewed records in `shared\training-media.json`; new tenant captures require a separately authenticated lab and pixel review before registration.

Site handles are not GitHub logins. My account allows a freshly authenticated change to an available public handle, preserving identity and records. Never merge accounts or transfer an occupied handle using provider email/handle matching.

The Worker Cron performs source checks and expired-record cleanup daily at 06:17 UTC. Check the public source register and Cloudflare Cron Events; the initial trigger can take time to propagate. The current Wrangler test hook is `/cdn-cgi/local/scheduled?format=json`, available only in development, not a public administrative endpoint.

Use D1's native export/Time Travel facilities for database recovery in the authenticated account. Encrypt and restrict operator exports, and define their retention before launch. Restoring an old database can restore deleted accounts or sessions; re-delete affected records and revoke sessions before exposing a restored service. Do not place exports in Git or static assets.

For CI deployment, configure a least-privileged Cloudflare API token and account ID as repository/environment secrets, the existing D1 database ID as a variable, and the final site/operator/contact/widget configuration as variables. `.github\workflows\deploy.yml` is manual and uses the protected `production` environment. It never creates a temporary account or approves policies on behalf of the operator.
