# BackendGen launch plan

## Product decision

Launch BackendGen as a free local compiler for AI coding users, not as a SaaS
subscription. The free CLI and MCP server create adoption; new, separately
licensed feature packs and implementation help create revenue. A hosted remote
MCP service is a later product only if browser-builder users prove they will pay
for zero-install access.

The reason to buy is not “more code generation.” Buyers get deterministic,
reviewable backend behavior that an agent can regenerate, test, and hand to a
frontend without repeatedly spending tokens rediscovering the repository.
Expansion measurements are evidence of compact input, not a token-savings
claim. Publish token claims only after controlled paired runs exist.

## Launch pricing experiment

Use low-friction one-time prices for the first 20 customers:

| Offer | Launch price | What the buyer receives |
|---|---:|---|
| Core CLI + local MCP | Free | All current Apache-2.0 features and local updates |
| Payments Pack, Indie | $39 once | One developer, up to three commercial projects, current major version, 12 months of updates |
| Payments Pack, Team | $129 once | Up to five developers, unlimited company projects, current major version, 12 months of updates |
| Guided setup | $79 once | One 60-minute implementation session and written handoff |
| Custom feature pack | Quote after a paid discovery | Fixed scope, acceptance tests, and license agreed before work |

After the first 20 sales, review conversion and support cost. Optional update
renewal can be $29/year Indie and $79/year Team; the software keeps working if
the buyer does not renew. Do not add a subscription merely to make revenue
recurring.

A future hosted plan can justify $5/month Hobby and $15/month Team only when it
offers real ongoing value: remote MCP for v0/Lovable web, authenticated private
projects, managed updates, execution isolation, team policies, and usage
history. None of that is in the local alpha, so do not sell it yet.

## Revenue opportunities in order

1. Sell the private Payments Pack directly with a simple license key and
   downloadable package. This is the cleanest product revenue.
2. Sell guided setup to early users. Their repeated problems define the next
   packs and documentation.
3. Offer fixed-price custom feature packs that can later become products when
   the customer agrees to reusable generic behavior.
4. Apply to the Lovable partner program and relevant AI-builder directories
   after the install path and demo have design-partner proof.
5. Publish the local server to the official MCP Registry for discovery. The
   registry is metadata, not a payment channel.
6. Add a remote MCP service only after at least five browser-only users ask for
   it and at least three agree to pay.
7. Consider enterprise identity/audit packs and paid upgrade support only after
   the Payments Pack has repeatable conformance evidence.

Avoid selling prompt packs, fake token-savings claims, per-generated-project
runtime royalties, or a subscription that only wraps the free local binary.

## Release sequence

### Repository owner supplies once

- A public GitHub repository and its exact `OWNER/repository` name.
- An npm account with 2FA enabled.
- A private repository or private package scope for commercial packs.
- A checkout product for one-time licenses (for example Lemon Squeezy, Gumroad,
  or Stripe Payment Links); choose based on supported country, tax handling,
  and payout availability before integrating anything.

### Maintainer runs before the first tag

```sh
npm run prepare:mcp-registry -- SiTouhemi Backendgen
npm ci
npm test
npm run test:fuzz:ci
npm run test:e2e
npm run test:distribution
npm run benchmark:expansion:check
```

Commit the resulting package metadata and `server.json`. The first npm publish
must bootstrap both package names because npm trusted publishing can only be
configured for packages that already exist. Create a short-lived granular npm
token with publish access, store it as the GitHub environment secret
`NPM_TOKEN`, create the protected `npm` environment, and publish GitHub release
`v0.2.1`. The release workflow tests, publishes both npm packages, and submits
MCP Registry metadata.

Review `server.json` carefully before that release. The official MCP Registry is
still a preview and currently does not support deleting a published server
version; publication is a discovery step, not a reversible draft.

Immediately after that first release:

```sh
npm install --global npm@11
npm trust github @2hemi/backendgen --repo SiTouhemi/Backendgen --file release.yml --env npm --allow-publish
npm trust github @2hemi/backendgen-mcp --repo SiTouhemi/Backendgen --file release.yml --env npm --allow-publish
```

Then delete the `NPM_TOKEN` secret and revoke the bootstrap token. Future
releases use short-lived GitHub OIDC credentials and npm provenance. Protect
release tags and require approval on the `npm` GitHub environment.

The unscoped `backendgen` name was rejected by npm as too similar to the
existing `backend-gen` package during the 0.2.0 bootstrap attempt. The release
therefore uses the owner-controlled public packages `@2hemi/backendgen` and
`@2hemi/backendgen-mcp` from 0.2.1 onward.

### Human validation before calling it stable

- Independent generated-code security review completed.
- Three design partners generate real backends and can regenerate after changes.
- At least one partner connects through MCP without maintainer intervention.
- Paired compiler-vs-direct model benchmark has at least three successful runs
  per arm and publishes raw result files.
- Payments Pack passes its separate security and conformance contract in Stripe
  test mode before any paid delivery.

Until these are true, label 0.2 as an alpha and sell the commercial pack as a
design-partner launch edition with a clear refund policy.
