## ADDED Requirements

### Requirement: A comment bridge replaces the provider only for comment operations
When a comment bridge is available for a channel, the system SHALL use it for listing comments,
replying and toggling visibility, and MUST NOT call the provider's comment methods for that
operation. Recent media and insights MUST keep using the provider. Without a bridge, behavior MUST
be identical to the direct provider path.

#### Scenario: Bridge configured for the channel
- **GIVEN** the bridge is configured and resolves the channel's account
- **WHEN** a member lists the comments of a media
- **THEN** the comments come from the bridge and the provider's `listComments` is not called

#### Scenario: Bridge not configured
- **GIVEN** no bridge key is set in the installation
- **WHEN** a member lists the comments of a media
- **THEN** the provider's `listComments` is called exactly as before

### Requirement: The bridge is restricted by organization and by account ownership
The bridge MUST only serve organizations listed in the installation allowlist. It MUST resolve the
external account by the channel's network user id, falling back to the username, among the accounts
visible to the bridge key, and MUST NOT serve a channel whose account it cannot resolve. Channel
lookup, active status and organization scoping MUST happen before the bridge is consulted.

#### Scenario: Organization outside the allowlist
- **GIVEN** the bridge is configured for organization A only
- **WHEN** a member of organization B lists comments of an Instagram channel
- **THEN** the direct provider path is used and the bridge is never called

#### Scenario: Account not visible to the bridge
- **GIVEN** the bridge key does not see the channel's Instagram account
- **WHEN** a member lists comments
- **THEN** the direct provider path is used

#### Scenario: Channel of another organization
- **WHEN** a member requests comments using a channel id of another organization
- **THEN** the API answers 404 `common.not_found` and the bridge is never called

### Requirement: Writes through the bridge require the media id
Replying and toggling visibility through the bridge MUST receive the media id of the commented post.
A missing media id MUST be rejected with a validation error before any network call. The media id
MUST match the numeric pattern used for other network identifiers.

#### Scenario: Reply without media id through the bridge
- **WHEN** a member replies to a comment without `mediaId` on a bridged channel
- **THEN** the API answers 400 and no request reaches the bridge

### Requirement: Bridge failures are classified without blaming the channel
Bridge authentication or authorization failures MUST answer `channel.provider_rejected` and MUST NOT
answer `channel.refresh_required`, because they concern the installation's bridge key and not the
channel token. Rate limiting and server errors MUST answer `channel.provider_failed`. A transport
failure on a write MUST be reported as uncertain and MUST NOT be retried automatically. Writes MUST
remain audited as on the direct path, and the bridge key MUST NOT appear in responses or logs.

#### Scenario: Bridge key revoked
- **WHEN** the bridge answers 401 to a comment listing
- **THEN** the API answers `channel.provider_rejected` and the channel status is unchanged

#### Scenario: Bridge rate limited
- **WHEN** the bridge answers 429
- **THEN** the API answers `channel.provider_failed`

#### Scenario: Reply through the bridge is audited
- **WHEN** a reply succeeds through the bridge
- **THEN** the audit log records `comment.replied` with the comment id and the reply id
