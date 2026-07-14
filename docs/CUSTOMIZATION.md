# Customization

Generated projects separate compiler-owned code from yours:

- `src/generated/` — owned by the compiler, replaced on every generation. Editing a file here is allowed, but the next `backendgen generate` refuses to overwrite the edit (a stable conflict, not data loss) until you revert it, move the behavior into `src/custom/`, or pass `--force`.
- `src/custom/` — scaffolded once, then never touched again. This is your extension surface.
- `.backendgen/manifest.json` — records every compiler-owned and custom-scaffold file with a content hash. This is how regeneration knows what it may replace.

`CustomModule` (`src/custom/custom.module.ts`) is imported last in `app.module.ts`, so providers you register there override generated defaults.

## The pattern: implement a generated interface

Generated behavior that is meant to be replaced is exposed as an injection token plus an interface in `src/generated/`, with a write-once starter implementation in `src/custom/`. Example — reservation rules:

```ts
// src/custom/reservation-policy.ts (yours, never regenerated)
import { Injectable } from '@nestjs/common';
import { ReservationPolicy, ReservationRequest } from '../generated/reservations/reservation-policy';

@Injectable()
export class CustomReservationPolicy implements ReservationPolicy {
  validateRequest(request: ReservationRequest): void {
    if (request.startsAt.getTime() < Date.now()) {
      throw new Error('A reservation cannot start in the past');
    }
  }
  // ...
}
```

Activate it in `src/custom/custom.module.ts`:

```ts
import { CUSTOM_RESERVATION_POLICY } from '../generated/reservations/reservation-policy';
import { CustomReservationPolicy } from './reservation-policy';

@Module({
  providers: [{ provide: CUSTOM_RESERVATION_POLICY, useClass: CustomReservationPolicy }],
  exports: [CUSTOM_RESERVATION_POLICY],
})
export class CustomModule {}
```

Because the policy lives in `src/custom/`, regeneration never conflicts with it, and because the generated service resolves the token, your rules run inside compiler-owned request handling.

## Custom notification transport

Set `features.notifications.provider: custom`, implement the generated `NotificationProvider` interface under `src/custom/`, and export it from `CustomModule`:

```ts
import { Module } from '@nestjs/common';
import {
  CUSTOM_NOTIFICATION_PROVIDER,
  type DeliveryResult,
  type NotificationMessage,
  type NotificationProvider,
} from '../generated/notifications/notification-provider';

class CompanyMailProvider implements NotificationProvider {
  readonly id = 'company-mail';

  async send(message: NotificationMessage): Promise<DeliveryResult> {
    const messageId = await companyMail.send(message); // your SDK/client
    return { providerId: this.id, messageId };
  }
}

@Module({
  providers: [
    CompanyMailProvider,
    { provide: CUSTOM_NOTIFICATION_PROVIDER, useExisting: CompanyMailProvider },
  ],
  exports: [CUSTOM_NOTIFICATION_PROVIDER],
})
export class CustomModule {}
```

Durable outbox delivery is at least once: a worker can crash after the provider accepts a message but before the database records success. Pass a stable provider-side idempotency key when your transport supports one. Never log recovery URLs, raw tokens, recipients, or message bodies. A missing custom provider fails application startup instead of silently falling back to the non-delivering log sink.

Every generation report lists the customization points for your specification. The MCP tool `explain_customization_points` returns the exact paths, interfaces, and events without returning file contents.

## Safe regeneration workflow

1. Edit the specification.
2. `backendgen diff backend.yaml --output ./my-api` — see exactly what would change, including conflicts, without writing.
3. `backendgen generate backend.yaml --output ./my-api`.

If generation reports a modified-file conflict, the right fix is almost always moving the behavior behind a customization point rather than `--force` (which discards your edit). Untracked files you created are preserved unless they collide with a newly generated path.

If the specification change altered entities, read [MIGRATIONS.md](MIGRATIONS.md) before deploying — the rewritten init migration must not be re-deployed over an applied one.
