# `@ctx/notifications` — table ownership

Notifications.

Channels, rules, quiet hours, and the delivery outbox. Knows only about events: it never imports a domain context. If Budgeting wants to notify, it emits an event.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; most do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

## Depends on

- Platform
- Identity (SecretBox)

## Tables

- `notification_channels`
- `notification_rules`
- `notification_outbox`
- `delivery_attempts`
