## ADDED Requirements

### Requirement: Automations are configured per channel and organization
A member SHALL create, edit, list and change the status of comment automations of a channel of their
organization. An automation MUST define a trigger (specific media ids or any media; keywords or any
comment), zero or more public reply variants, an opening private message, zero or more questions
(choice with 1 to 13 options, or text with a field type) and a final message with an optional
WhatsApp button. Status MUST be one of draft, test, active or paused. Every read and write MUST be
scoped by organization, and a channel of another organization MUST answer `common.not_found`.

#### Scenario: Create an automation for another organization's channel
- **WHEN** a member of organization A creates an automation using a channel id of organization B
- **THEN** the API answers 404 `common.not_found` and nothing is stored

#### Scenario: Invalid configuration
- **WHEN** a choice question has 14 options or a button title has more than 20 characters
- **THEN** the API answers 400 and nothing is stored

### Requirement: Inbound events are authenticated, stored once and processed asynchronously
The system SHALL accept bridge events only on the public webhook route when the installation secret
is configured, MUST verify the HMAC-SHA256 signature of the raw body in constant time, MUST reject a
missing or invalid signature with 401 without storing anything, MUST store each event once keyed by
its event id, MUST answer 2xx within the bridge timeout and MUST process the event in a queue job.
Events for accounts that do not map to a channel of an allowed organization MUST be discarded.

#### Scenario: Forged event
- **WHEN** a request arrives without a valid `X-Zernio-Signature`
- **THEN** the API answers 401 and no event is stored or processed

#### Scenario: Redelivered event
- **WHEN** the same event id arrives twice
- **THEN** it is stored and processed only once and both deliveries receive 2xx

#### Scenario: Secret not configured
- **WHEN** `ZERNIO_WEBHOOK_SECRET` is not set
- **THEN** the webhook route answers 404

### Requirement: A matching comment starts exactly one run
For a top-level comment not written by the account itself, the system SHALL select the oldest active
automation of the channel whose media and keyword trigger match (keywords compared case- and
accent-insensitively as whole words or phrases). An automation in test status MUST only match
comments whose author username is in its test list. The system MUST create at most one run per
automation and comment; a duplicated or concurrent trigger for the same comment MUST NOT send
anything twice.

#### Scenario: Keyword with accent and case
- **GIVEN** an active automation with keyword "cotação"
- **WHEN** someone comments "Quero uma COTACAO"
- **THEN** a run is created for that comment

#### Scenario: Test mode
- **GIVEN** an automation in test status with test username "iagovieira.ia"
- **WHEN** another user comments the keyword
- **THEN** no run is created

#### Scenario: Own reply re-delivered as comment
- **WHEN** the comment event is authored by the connected account
- **THEN** no run is created

### Requirement: The run replies publicly once and privately once
After creating a run, the system SHALL post one public reply chosen among the variants (when any) and
SHALL send one private reply to the comment with the opening message, the automated-message
disclosure and the first question's options (buttons up to 3, quick replies from 4 to 13). Each send
MUST carry an idempotency key derived from the run and step. A failure the bridge reports as already
consumed or as an unknown outcome MUST mark the run failed or uncertain and MUST NOT be retried
automatically; a transient failure before sending MAY be retried by the queue.

#### Scenario: Private reply already consumed
- **WHEN** the bridge answers that the comment's private reply was already used
- **THEN** the run is marked failed with that reason and no further message is sent

#### Scenario: Public reply fails but private reply works
- **WHEN** the public reply is rejected and the private reply succeeds
- **THEN** the run continues and records the public reply failure

### Requirement: Direct messages advance the run and capture the lead
An incoming direct message from the run's participant within 24 hours of the last interaction SHALL
advance the run: a tapped option (identified by its payload) or a valid text answer is recorded under
the question's field and the next question is sent; an invalid text answer to a text question is
re-asked once. Messages on the standby path, outgoing messages and messages from participants without
an open run MUST be ignored. After the last question the system SHALL send the final message with the
WhatsApp button (when configured), mark the run completed and emit `lead.captured` once.

#### Scenario: Option tapped
- **WHEN** the participant taps the second option of the first question
- **THEN** the answer is stored and the second question is sent

#### Scenario: Invalid phone answer
- **WHEN** the participant answers "não sei" to a WhatsApp-number question
- **THEN** the question is asked again once and the run stays on the same step

#### Scenario: Lead captured
- **WHEN** the participant answers the last question
- **THEN** the final message is sent, the run is completed and one `lead.captured` webhook is emitted
  with the automation, channel, participant username, comment, media and answers

### Requirement: Leads are listed per organization
The app SHALL list runs as leads (date, participant username, automation, post, status and answers),
scoped by organization, filterable by automation and status, with cursor pagination.

#### Scenario: Leads of another organization
- **WHEN** a member lists leads
- **THEN** only runs of the member's organization are returned
