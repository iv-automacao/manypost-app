## ADDED Requirements

### Requirement: Engagement is an optional provider capability
The provider contract SHALL expose engagement operations (recent media, comments, comment reply,
comment visibility, account insights, media insights) as optional methods. The platform MUST answer
`capability.disabled` without calling the network when the channel's provider does not implement
the requested operation. The `instagram-standalone` provider MUST implement all of them.

#### Scenario: Provider without engagement
- **WHEN** a member requests comments for a channel whose provider has no engagement methods
- **THEN** the API answers 404 `capability.disabled` and no request reaches the social network

#### Scenario: Instagram Login channel
- **WHEN** a member requests recent media for an active `instagram-standalone` channel
- **THEN** the provider calls `graph.instagram.com` with the channel's decrypted token and the API
  returns the media list

### Requirement: Engagement access is scoped to the organization and to an active channel
Every engagement operation MUST resolve the channel by organization id and channel id. A channel
of another organization, a deleted channel or an unknown id MUST answer `common.not_found`. A
channel whose status is not `ACTIVE` MUST answer `channel.refresh_required` without a network call.
The read path MUST NOT change the channel status.

#### Scenario: Channel from another organization
- **WHEN** a member of organization A requests comments using a channel id of organization B
- **THEN** the API answers 404 `common.not_found` and the token of B is never decrypted

#### Scenario: Channel waiting for reconnection
- **WHEN** a member requests insights for a channel in `REFRESH_REQUIRED`
- **THEN** the API answers `channel.refresh_required` and makes no network call

### Requirement: Required permission is checked before the network call
Comment operations MUST require the provider's comment-management scope and insight operations
MUST require the provider's insights scope, as recorded on the channel at connection time. A
missing scope MUST answer `channel.missing_scopes` naming the scope, without a network call.

#### Scenario: Insights without the insights permission
- **WHEN** the channel scopes do not include `instagram_business_manage_insights`
- **THEN** the API answers `channel.missing_scopes` with the missing scope in the detail

### Requirement: Recent media and comments are listed with cursor pagination
The system SHALL list the account's recent media (id, type, caption, permalink, thumbnail,
timestamp, like and comment counts) and the comments of one media (id, text, author username,
timestamp, like count, hidden flag, whether the author is the account itself, and direct replies).
Both MUST page with an opaque cursor returned by the network and MUST cap the page size.

#### Scenario: Next page of comments
- **WHEN** a member requests comments with the cursor returned by the previous page
- **THEN** the API returns the following comments and a new cursor, or no cursor at the end

#### Scenario: Own reply is identified
- **WHEN** a comment reply was written by the connected account
- **THEN** the reply is marked as authored by the account

### Requirement: External identifiers are validated before reaching the network
Media and comment identifiers MUST match a numeric pattern before being placed in a network URL.
Anything else MUST be rejected as a validation error without a network call.

#### Scenario: Path injection attempt
- **WHEN** a request uses `../me` as a comment id
- **THEN** the API answers 400 and no request reaches the social network

### Requirement: Replying to a comment is explicit, bounded and audited
A member SHALL reply publicly to a comment with a non-empty message of at most 2200 characters.
The route MUST honor `Idempotency-Key` so a repeated submission returns the first result instead of
replying twice. Each successful reply MUST be appended to the audit log with actor, channel, comment
id and reply id, without the token. A transport failure after the request was sent MUST be reported
as uncertain and MUST NOT be retried automatically.

#### Scenario: Double submission
- **WHEN** the same reply is posted twice with the same `Idempotency-Key`
- **THEN** only one reply is created on the network and both responses carry the same reply id

#### Scenario: Timeout after sending
- **WHEN** the network connection drops after the reply request was sent
- **THEN** the API answers `channel.provider_failed` with `uncertain: true` and the system does not
  retry on its own

#### Scenario: Empty message
- **WHEN** the reply message is blank after trimming
- **THEN** the API answers 400 and no request reaches the social network

### Requirement: Comment visibility can be toggled and is audited
A member SHALL hide or unhide a comment on the account's media. The operation MUST be idempotent
(hiding a hidden comment succeeds) and MUST be appended to the audit log.

#### Scenario: Hide a comment
- **WHEN** a member hides a comment
- **THEN** the network receives `hide=true` for that comment and the audit log records the action

### Requirement: Account insights cover a bounded period and degrade per metric
The system SHALL return account totals for a period of at most 30 days (reach, views, accounts
engaged, total interactions, likes, comments, shares, saves), the current follower count and a
daily reach series. A metric the network rejects MUST come back as unavailable (`null`) without
failing the others. Periods longer than 30 days or ending in the future MUST be rejected.

#### Scenario: One metric no longer supported
- **WHEN** the network rejects one metric name of the requested set
- **THEN** the response carries that metric as `null` and the remaining metrics with values

#### Scenario: Period too long
- **WHEN** a member requests 45 days
- **THEN** the API answers 400 without a network call

### Requirement: Per-post insights isolate failures per post
The system SHALL return, for the account's recent media, lifetime metrics per post (reach, views,
likes, comments, shares, saves, total interactions). A post whose metrics the network refuses MUST
be returned with unavailable metrics and a reason, without failing the page.

#### Scenario: Post without metrics
- **WHEN** the network refuses insights for one post of the page
- **THEN** that post is listed with `null` metrics and the others with their values

### Requirement: External failures are classified and never leak secrets
Network failures MUST map to: expired or revoked token → `channel.refresh_required`; refusal of the
request → `channel.provider_rejected` (422) with a sanitized message; unavailability or rate
limiting → `channel.provider_failed` (502). Responses and logs MUST NOT contain the access token.

#### Scenario: Revoked token
- **WHEN** the network answers with an OAuth error for the channel token
- **THEN** the API answers `channel.refresh_required` and the channel status is unchanged

### Requirement: Comments and Insights screens
The app SHALL offer a Comentários screen (choose a channel, browse recent posts, read comments with
replies, reply, hide/unhide) and an Insights screen (account totals for a chosen period up to 30
days, daily reach, follower count and a per-post table). Both MUST list only channels whose provider
supports engagement, show an empty state when there is none, offer reconnection when the API answers
`channel.refresh_required` or `channel.missing_scopes`, and keep the reply action disabled while a
reply is in flight. The Insights screen MUST state that the network may delay data by up to 48 hours.

#### Scenario: No eligible channel
- **WHEN** the organization has no Instagram channel with engagement support
- **THEN** both screens show an empty state pointing to Conexões

#### Scenario: Reply in flight
- **WHEN** a member submits a reply
- **THEN** the send button stays disabled until the API answers, and the thread refreshes on success
