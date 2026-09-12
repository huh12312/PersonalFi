# `@ctx/identity` — table ownership

Identity & Security.

Authentication, sessions, recovery, rate limiting and the security audit trail.

Cryptography itself lives one layer down in **`@core/secretbox`**, which owns
`encryption_keys`. That split is forced by the boundary lint rather than chosen for
taste: `personalfi/layer-imports` denies `@ctx/*` → `@ctx/*`, so a `SecretBox` owned
by this context could never be the chokepoint `@ctx/connections` and
`@ctx/integrations` must call. Identity is the *first consumer* of SecretBox (the
TOTP seed), not its owner.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; some do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

## Depends on

- Platform
- `@core/secretbox` (sealing the TOTP seed)

## Tables

- `users`
- `sessions`
- `webauthn_credentials`
- `webauthn_challenges`
- `totp_secrets`
- `recovery_codes`
- `registration_tokens`
- `auth_attempts`
- `auth_lockouts`
- `security_events`
- `api_tokens`
