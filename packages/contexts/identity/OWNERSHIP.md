# `@ctx/identity` — table ownership

Identity & Security.

Authentication, sessions, key custody, and the audit trail. Owns `SecretBox`, the single chokepoint through which every other context encrypts anything: no context may import a crypto library directly.

Exactly one context may write a table, and only that context may read it directly.
Everyone else goes through this context's published interface or a read model. The
`pnpm lint:schema-ownership` check parses the list below, so it is the contract, not
a comment: a table defined outside its owning package, or claimed twice, fails CI.

Tables listed here are _claimed_; most do not exist yet. Claiming early is the point
— it is what makes a collision visible at design time instead of at migration time.

## Depends on

- Platform

## Tables

- `users`
- `sessions`
- `webauthn_credentials`
- `totp_secrets`
- `recovery_codes`
- `api_tokens`
- `key_metadata`
- `audit_log`
- `auth_attempts`
