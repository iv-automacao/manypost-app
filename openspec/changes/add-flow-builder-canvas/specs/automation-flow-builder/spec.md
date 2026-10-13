## ADDED Requirements

### Requirement: Automation flows are stored as validated graphs
An automation SHALL store its flow as a version 2 graph of nodes (opening, message, question,
condition, link, end) and edges from a named node output to a target node. The API
MUST reject, with 400 and nothing stored, a flow that breaks the shape rules: more than 40 nodes or
120 edges, duplicated node or option ids, more than one edge per node output, an edge to a missing
node or into the opening, not exactly one opening, a button title over 20 characters, more than 3
buttons or 13 quick replies, a text over 600 characters, or a non-https link. Every read and write
MUST be scoped by organization, and an automation or channel of another organization MUST answer
`common.not_found`.

#### Scenario: Too many buttons
- **WHEN** a member saves a message node with format buttons and 4 options
- **THEN** the API answers 400 and the stored flow is unchanged

#### Scenario: Automation of another organization
- **WHEN** a member of organization A reads or saves an automation id of organization B
- **THEN** the API answers 404 `common.not_found`

### Requirement: Flow problems block test and active status
The system SHALL compute flow problems: unreachable node, required output without an edge, a cycle
without any node that waits for the participant, a condition on a field no node records, and no
reachable end or link; these are errors. An opening in button mode SHALL produce a warning, because
Instagram refuses buttons in a private reply to non-followers; warnings MUST NOT block anything. A
new opening SHALL default to text mode. A flow with errors MAY be saved while the automation is draft or paused.
The API MUST reject saving or changing status to test or active while any error exists, with 400
`automation.flow_invalid` and the problem list. The editor SHALL show the same problems live and
focus the node when a problem is selected.

#### Scenario: Loop without waiting
- **GIVEN** a message without buttons whose output leads to a condition that leads back to it
- **WHEN** a member tries to activate the automation
- **THEN** the API answers 400 `automation.flow_invalid` with a `wait_free_cycle` problem and the
  status is unchanged

#### Scenario: Opening with a button
- **WHEN** a member activates a valid flow whose opening is in button mode
- **THEN** the status changes and the response lists an `opening_button` warning

#### Scenario: Draft with an unconnected button
- **WHEN** a member saves a draft whose message has a button without an edge
- **THEN** the flow is stored and the response lists a `missing_edge` problem

### Requirement: Triggers are stored apart from the flow
The system SHALL store triggers in their own table, each bound to one automation, with kind
`comment` carrying media ids (empty means any post), keywords (empty means any comment) and public
reply variants. A matching comment SHALL start a run on the oldest matching trigger among active
automations, plus test automations whose test usernames include the author, using the same
case- and accent-insensitive whole-word matching as before. The migration MUST create one comment
trigger for every existing automation from its current configuration, MUST be idempotent and MUST
NOT modify existing automation configurations.

#### Scenario: Existing automation after the migration
- **GIVEN** an active version 1 automation with keyword "plano"
- **WHEN** the migration runs and someone comments "PLANO"
- **THEN** a trigger row exists for that automation and a run starts exactly as before

#### Scenario: Migration re-run
- **WHEN** the trigger backfill runs twice
- **THEN** each automation has exactly one comment trigger

### Requirement: The engine walks the graph and waits only on waiting nodes
For an open run the engine SHALL send the current node's message once, stop on nodes that wait
(opening, message with options, question), and otherwise follow the node's output
(condition by comparing the recorded field, message without options by its next output, link by its
next output or finish, end by finishing) in the same event, up to 20 nodes per event. Each
conversation send MUST carry an idempotency key derived from the run and its node-entry cursor, and
every effect MUST be recorded right after it is confirmed so that a retried job resumes without
resending. Reaching an end, or a link without an outgoing edge, MUST complete the run and emit
`lead.captured` once. A run whose current node no longer exists MUST end as abandoned without
sending anything. A permanent send failure MUST fail the run with its reason; an unknown outcome
MUST mark it uncertain and MUST NOT be resent automatically; a transient failure MAY be retried by
the queue.

#### Scenario: Branch by button
- **GIVEN** a message with buttons "Minha empresa" and "Pessoa física" leading to different nodes
- **WHEN** the participant taps "Pessoa física"
- **THEN** the answer is recorded in the message's field and only the "Pessoa física" path is sent

#### Scenario: Chained messages
- **GIVEN** a message without buttons followed by a question
- **WHEN** the run reaches the message
- **THEN** both are sent in order in the same event and the run waits on the question

#### Scenario: Retry after a transient failure
- **WHEN** the second of two chained sends fails transiently and the job is retried
- **THEN** the first message is not sent again and the second is sent once

#### Scenario: WhatsApp number saved without country code
- **WHEN** a link targets a WhatsApp number with 11 digits
- **THEN** the sent URL uses wa.me/55<digits>

#### Scenario: Node deleted while waiting
- **GIVEN** a run waiting on a node that a member deleted
- **WHEN** the participant replies
- **THEN** the run ends as abandoned and nothing is sent

### Requirement: Participant input follows the current node only
The engine SHALL locate the run by the `mp2` payload (run, node, output) or by the legacy `mp1`
payload, and otherwise by the participant's most recent open run within 7 days. A payload for a node
other than the current one MUST be ignored. On a message with options, a tap or a text equal to an
option title (accent- and case-insensitive) SHALL follow that option; other text SHALL follow the
typed output when the node is set to branch, and otherwise SHALL be asked again once and then be
recorded raw and follow the typed output, or the first option when the typed output has no edge. A
question SHALL record a valid answer, ask again once on an invalid one and then accept the raw text.

#### Scenario: Stale tap
- **GIVEN** a run already waiting on the second question
- **WHEN** the participant taps a button of the first question
- **THEN** nothing is recorded and nothing new is sent

#### Scenario: Typed text on a buttons message
- **GIVEN** a message with buttons set to ask again
- **WHEN** the participant types an unrelated text twice
- **THEN** the message is sent again once and, on the second text, the text is recorded and the run
  follows the typed output

### Requirement: Version 1 automations and runs keep working
The system SHALL convert a version 1 configuration to a graph on read with deterministic node and
option ids, without rewriting it in the database. For the same participant inputs, the converted
flow MUST send the same sequence of messages as the version 1 engine. An open version 1 run SHALL
be mapped from its step to the converted node on first use, and `mp1` payloads SHALL keep working.
Saving an automation through the API SHALL store version 2.

#### Scenario: Production-shaped flow equivalence
- **GIVEN** a version 1 configuration with an opening button, two choice questions and a WhatsApp
  finish
- **WHEN** the same taps and texts are replayed against the version 1 and the converted flow
- **THEN** both send identical messages in identical order

#### Scenario: Run in progress during deploy
- **GIVEN** a version 1 run waiting on question 1
- **WHEN** the participant taps an `mp1` button after the deploy
- **THEN** the run maps to node `q1`, records the answer and continues

### Requirement: The canvas editor builds, validates and simulates flows
The app SHALL edit flows on a canvas with these capabilities:
- Text and options are edited inside each balloon.
- A settings menu per balloon holds format, field and typed-text behavior.
- Dropping an edge on empty space opens a next-step menu.
- A block dock lists the blocks, including a "Pedir para seguir" shortcut that creates a link
  balloon pointing to the channel account's profile. It never checks whether the participant
  follows and never blocks the flow.
- The selected balloon offers duplicate, test from here and delete.
- The canvas offers auto-layout, zoom, fit, undo and redo.
- A live problem count is shown.
- Leaving with unsaved changes asks for confirmation.

The opening SHALL NOT be deletable. A conversation simulator SHALL run the flow locally, without
sending anything, Below 768 px wide the canvas MUST be
read-only. The web logic MUST produce the same problems and messages as the server for the shared
fixtures.

#### Scenario: Next step from a dropped edge
- **WHEN** a member drags the output of a button to empty space and picks "Pergunta"
- **THEN** a question balloon is created at that point already connected to that button

#### Scenario: Follow request after the data
- **WHEN** a member adds "Pedir para seguir" after the WhatsApp link and simulates the flow
- **THEN** the simulator shows the follow message with a button to the account profile after the
  WhatsApp message, and the run completes with the lead without waiting for any answer

#### Scenario: Simulate a branch
- **WHEN** a member simulates the flow and taps the second button of a message
- **THEN** the simulator shows only the messages of that button's path and nothing reaches the
  bridge

#### Scenario: Parity with the server
- **WHEN** the shared flow fixtures run in the web tests and in the core tests
- **THEN** both produce the expected problems and message sequences
