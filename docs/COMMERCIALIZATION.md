# Commercialization boundary

Backend Compiler should earn revenue by selling high-value capabilities and
assurance around the local compiler, without weakening the open foundation that
earns adoption.

## Recommended open-core split

Keep the code already present under Apache-2.0 open: the specification,
compiler and IR, SDKs, NestJS/Prisma target, CLI/MCP interfaces, conformance
tools, and the current CRUD, auth, organizations, reservations, notifications,
jobs, webhooks, and uploads packs. Do not retroactively remove working features
or present previously open code as newly proprietary.

Commercial packages should be new, separately licensed feature packs that use
the same public `FeaturePack` and target renderer contracts. Keep them in a
private repository or authenticated package registry so the Apache repository
has an unambiguous license boundary.

Do not add runtime plugin scanning to the open compiler merely to support the
commercial package. Feature discovery is deliberately explicit and auditable.
Build a separate private `backendgen-pro` distribution that composes a pinned
core revision with the private pack in its registry, then runs the same public
conformance and distribution smoke suites. The private repository should retain
the Apache notices for copied core code and apply its commercial license only to
new pack files. Generated customer repositories remain theirs and must not
contain a license check or BackendGen runtime dependency.

Deliver early licenses through an authenticated download or private npm scope.
Use a license record to authorize downloads and updates, not to phone home from
generated applications. Pin each pro release to one core version, publish its
compatibility matrix, and never silently load executable packs from the
filesystem or network.

The first paid product should be a payments pack. Follow it with enterprise
identity/audit packs and a paid verified-update/support channel. Hosted
collaboration can be considered after design-partner evidence; local generation
must remain a complete workflow.

## Paid payments pack: proposed scope

### Phase 1 — SaaS billing

Generate a Stripe-backed billing module with:

- customer mapping to an authenticated account or organization;
- server-created Checkout sessions for an allowlisted price catalog;
- a Stripe-hosted Customer Portal session;
- subscription and entitlement projections updated from verified webhooks;
- an authenticated read endpoint for the caller's current entitlement;
- append-only webhook receipt records with unique provider event ids;
- customization points for plan-to-entitlement policy.

Stripe documents Checkout/custom subscription flows for fixed, per-seat, and
usage-based billing, and provides a hosted Customer Portal for payment method,
subscription, invoice, and billing-information management. Use those hosted
surfaces first to minimize generated PCI-sensitive UI and support code:

- <https://docs.stripe.com/billing/subscriptions/build-subscriptions>
- <https://docs.stripe.com/customer-management>

### Phase 2 — marketplace payments

Add Stripe Connect as a separate capability: connected-account onboarding,
account status, destination charges, platform fees, refunds, transfers, and
dispute/reversal synchronization. Destination charges create the platform
charge and transfer funds to the connected account in the same transaction:

- <https://docs.stripe.com/connect/destination-charges>

Do not mix marketplace money movement into the Phase 1 subscription model. Its
ownership, liability, regional availability, refunds, and reconciliation rules
need a separate specification and conformance suite.

## Non-negotiable generated security contract

The paid pack is not releasable until deterministic tests prove all of these:

- the browser can select only server-configured price ids, never submit an
  arbitrary amount, currency, destination account, or platform fee;
- Stripe secrets exist only in environment declarations and are never written
  to specifications, manifests, logs, DTOs, or generated fixtures;
- webhook signatures are verified over the unmodified raw request body before
  JSON parsing, and only subscribed event types are processed;
- provider event ids are unique and duplicate or out-of-order events converge
  without duplicating entitlements or money movement;
- every outbound create/update uses a stable, principal-scoped idempotency key
  and a request fingerprint. Stripe recommends idempotency keys for safely
  retrying object creation and updates:
  <https://docs.stripe.com/api/idempotent_requests>;
- redirects are presentation only; subscription state and entitlements come
  from verified asynchronous events. Stripe's webhook documentation describes
  those events as the channel for asynchronous payment and subscription state:
  <https://docs.stripe.com/webhooks>;
- customer, subscription, event, connected-account, and entitlement records are
  tenant scoped on every read and write;
- prices and money are stored as integer minor units plus currency, never
  floating-point values;
- logs persist bounded machine categories, not request bodies, provider bodies,
  cardholder data, emails, or secrets.

The conformance matrix must include duplicate delivery, reordering, timeout and
retry, cross-tenant identifiers, forged signatures, deleted users, cancelled and
past-due subscriptions, refunds, and replayed idempotency keys. A fake provider
can exercise unit tests; release evidence must also use Stripe test mode and its
CLI webhook forwarding against PostgreSQL.

## Distribution and pricing experiment

Start with a design-partner license rather than permanent pricing:

- one commercial project license for the payments pack and updates;
- a higher team tier with private support and upgrade/conformance assistance;
- no per-generated-project runtime royalty, which would undermine local-first
  adoption and be difficult to enforce cleanly.

Measure paid conversion, support time, successful production launches, and
upgrade friction before committing to hosted billing or a marketplace. The
token benchmark remains a separate evidence project and must never use invented
measurements.
