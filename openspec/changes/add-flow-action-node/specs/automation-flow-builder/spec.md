## ADDED Requirements

### Requirement: Action nodes run an effect and continue
The flow graph SHALL accept an `action` node with exactly one required output `next` and data of one
of two kinds: `send_data` with a `label` matching `^[a-z][a-z0-9_]{0,31}$`, or `notify` with a `text`
of 1 to 280 characters that MAY contain `{field}` placeholders. An action node has no
`delaySec` (a value sent for it is dropped, as for the opening), MUST NOT send any message to the participant and MUST NOT wait for an answer. When a run
reaches an action node that was not executed yet on its cursor, the engine SHALL execute the effect,
record the node as executed on that cursor and follow `next` in the same step, counting toward the
limit of automatic steps. Resuming or reprocessing the run on the same cursor MUST NOT execute the
effect again once it was recorded. The API MUST reject an action node with an invalid label or an empty
or too long text with 400.

#### Scenario: Action between two questions
- **GIVEN** a flow "WhatsApp?" question → action `send_data` `whatsapp_coletado` → "Pode chamar?" message
- **WHEN** the participant answers the WhatsApp question
- **THEN** the effect runs once and "Pode chamar?" is sent in the same event, with no message for the
  action itself

#### Scenario: Resume does not repeat the effect
- **GIVEN** a run that already executed an action on cursor 6 and is waiting on cursor 7
- **WHEN** a resume or reminder job reprocesses the run
- **THEN** the action effect is not executed again

#### Scenario: Action without a connected output
- **GIVEN** an action node whose `next` is not connected
- **WHEN** the flow is validated
- **THEN** the problem `missing_edge` is reported for that node and Test and Active are blocked

#### Scenario: Invalid label
- **GIVEN** an action `send_data` with label `WhatsApp coletado`
- **WHEN** the flow is saved
- **THEN** the API answers 400 and the editor blocks saving and points at the node

### Requirement: Send data emits lead.updated
The webhook event catalog SHALL include `lead.updated`. An executed `send_data` action SHALL emit
`lead.updated` through the outgoing webhook pipeline (signed envelope, delivery log, retries, event and
channel filters) with `label`, `nodeId`, `cursor` (the run cursor of that pass), `runId`, `automationId`, `automationName`, `channelId`,
`mediaId`, `commentId`, `commentText`, `participantId`, `participantUsername`, the answers collected so
far, `whatsappUrl` (null when the flow has no WhatsApp link yet), `status` `OPEN`, `test` true when the
automation is in Test mode and `sentAt`. Delivery is at least once; receivers deduplicate by `runId`,
`nodeId` and `cursor`, so a later pass through the same node (a loop that corrects an answer) is a
new event. A failure to deliver to a webhook MUST NOT stop or fail the run. A failure to record the
emission SHALL make the job fail so the queue retries it. With no subscribed webhook the action SHALL
be a no-op. The `lead.captured` event MUST keep its fields, SHALL gain `test` (true when the automation is in
Test mode, an additive change) and SHALL still be emitted once when the run completes.

#### Scenario: CRM receives the lead before the end
- **GIVEN** a webhook subscribed to `lead.updated` and `lead.captured`, and the Triagem flow with a
  `send_data` action right after the WhatsApp question
- **WHEN** the participant answers the WhatsApp question and later completes the flow
- **THEN** the webhook receives a signed `lead.updated` with label `whatsapp_coletado` and the
  WhatsApp answer, and later one `lead.captured` with the unchanged payload

#### Scenario: Participant stops after giving the WhatsApp
- **GIVEN** the same flow
- **WHEN** the participant answers the WhatsApp question and never answers again
- **THEN** the webhook still received `lead.updated` with the WhatsApp answer, and no `lead.captured`

#### Scenario: Test mode is flagged
- **GIVEN** an automation in Test mode
- **WHEN** a tester passes a `send_data` action
- **THEN** the `lead.updated` payload has `test` true

#### Scenario: A loop corrects the answer
- **GIVEN** "WhatsApp?" → `send_data` action → "Está certo?" with "Corrigir" going back to "WhatsApp?"
- **WHEN** the participant answers, taps "Corrigir" and answers again
- **THEN** two `lead.updated` are emitted with different `cursor` values, the second with the
  corrected answer

#### Scenario: Test mode on the completed lead
- **GIVEN** an automation in Test mode
- **WHEN** a tester completes the flow
- **THEN** `lead.captured` has `test` true; for an active automation it has `test` false

#### Scenario: Receiver is down
- **GIVEN** a subscribed webhook that answers 500
- **WHEN** a `send_data` action runs
- **THEN** the run continues to the next node and the delivery is retried by the webhook pipeline

### Requirement: Notify creates a team notification
An executed `notify` action SHALL create one notification for the whole organization with kind
`automation.notify`, the automation name as title, the action text with `{field}` placeholders filled
from the answers and the participant username as body, and a link to the leads page. A failure to
create it SHALL make the job fail so the queue retries it.

#### Scenario: Team is told a company lead arrived
- **GIVEN** an action `notify` with text "Lead empresa: {nome}" after the name question
- **WHEN** the participant "Ana" passes the action
- **THEN** the organization gets one notification titled with the automation name, body
  "Lead empresa: Ana" and a link to /leads

### Requirement: The editor and simulator support action nodes
The flow editor SHALL offer "Ação" as an enabled block in the dock and in the next-step menu, edit the
kind and its field inside the node, and block saving while the label or text is invalid. The simulator
SHALL show an executed action as a system line ("⚡ Enviaria dados: <label>" or "⚡ Avisaria a equipe:
<filled text>") without sending or emitting anything, and continue the simulation through `next`.
Webhook settings SHALL list `lead.updated` among the selectable events.

#### Scenario: Simulating the Triagem with an action
- **GIVEN** the Triagem flow with a `send_data` action after the WhatsApp question
- **WHEN** the user simulates and answers the WhatsApp question
- **THEN** the conversation shows "⚡ Enviaria dados: whatsapp_coletado" followed by the next message,
  and no webhook delivery is created
