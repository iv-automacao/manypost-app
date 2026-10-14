## ADDED Requirements

### Requirement: Nodes can wait before sending
Message, question, link and end nodes SHALL accept `delaySec` from 0 to 60 (default 0); the opening
MUST NOT have a delay. When the engine reaches an unsent node with a delay it SHALL show the typing
indicator (best effort), store the due time on the run, schedule a resume job on the serial
automation queue and stop. The node MUST be sent only at or after the due time, by the resume job or
by a later event of the same run, with the same idempotency key, and a participant message received
before the due time MUST NOT anticipate it. A resume job for a run that is no longer open, whose
cursor moved, or whose automation is paused or draft MUST do nothing. The API MUST reject a
`delaySec` outside 0..60 with 400.

#### Scenario: Follow request five seconds after the WhatsApp link
- **GIVEN** a link node followed by a "Seguir" link with `delaySec` 5
- **WHEN** the run sends the WhatsApp link
- **THEN** the "Seguir" message is not sent in the same event, a resume job is scheduled for five
  seconds later, and the job sends it once

#### Scenario: Participant writes during the delay
- **GIVEN** a run whose next node is waiting for its delay
- **WHEN** the participant sends a message before the due time
- **THEN** nothing is sent, the message is recorded as the last inbound time, and the node is sent
  only when the resume job runs

#### Scenario: Stale resume job
- **GIVEN** a resume job for cursor 4
- **WHEN** it runs after the run already moved to cursor 5 or completed
- **THEN** nothing is sent

### Requirement: One reminder brings back a participant who stopped answering
A flow MAY define `reminder` with `afterMinutes` from 5 to 1380 and a text up to 300 characters. When
a participant message leaves an open run waiting on an already sent node other than the opening,
the engine SHALL schedule one reminder at the participant's last message time plus `afterMinutes`,
never later than 23 hours after it. When the reminder job runs and the run is still open on the same
cursor with that node sent, no reminder was sent yet, the automation is not paused or draft, the flow
still has a reminder and the last participant message is at most 23 hours and 30 minutes old, the
engine SHALL send the rendered reminder text as a plain message and then the node's message again
with its options, each with an idempotency key derived from the run and cursor, and record that the
reminder was sent. A reminder job that runs before the due time SHALL be rescheduled for it, and a
timer job that cannot reach the bridge SHALL fail so the queue retries it. A run MUST receive at most one reminder, and a run that is still waiting on the
opening MUST NOT receive any.

#### Scenario: Participant stops at the city question
- **GIVEN** a flow with a reminder after 60 minutes and a run waiting on "Em qual cidade?" after the
  participant's last answer
- **WHEN** 60 minutes pass without a new message
- **THEN** the participant receives the reminder text and then "Em qual cidade?" with its quick
  replies, and a tap on "Manaus" continues the flow

#### Scenario: Participant answers before the reminder
- **GIVEN** a reminder scheduled for the city question
- **WHEN** the participant answers the city before it is due
- **THEN** the reminder job sends nothing

#### Scenario: Never answered the opening
- **GIVEN** a run whose participant never replied to the private reply
- **WHEN** the reminder time would have passed
- **THEN** no reminder is scheduled or sent

#### Scenario: Only one reminder
- **GIVEN** a run that already received its reminder and then answered one more question
- **WHEN** the participant stops again
- **THEN** no second reminder is sent

### Requirement: The editor configures and simulates delays and the reminder
The canvas editor SHALL offer "Esperar antes de enviar" (0, 2, 5, 10, 30 or 60 seconds) in the
settings of message, question, link and end nodes, show the delay on the node, and offer a
"Lembrete" control in the editor top bar to enable the reminder, choose its time and edit its text.
The simulator SHALL show a typing line with the delay before a delayed message and, while waiting on
a node after the opening with an unsent reminder, offer "Simular silêncio" to show the reminder
message.

#### Scenario: Simulating silence
- **GIVEN** a flow with a reminder and the simulator waiting on the city question
- **WHEN** the member clicks "Simular silêncio"
- **THEN** the transcript shows the reminder text and then the city question with its options, and
  the button disappears
