## ADDED Requirements

### Requirement: The opening can offer one quick reply
An opening node SHALL accept the mode `quick` in addition to `text` and `button`. In `quick` mode
the private reply MUST carry the opening text, the reply hint, the disclosure when enabled, and
exactly one quick reply titled with the node's button title and carrying the `mp2` payload of the
opening's `next` output. A tap on that quick reply or any typed text SHALL advance the run through
`next`, as in `text` mode. The `quick` mode MUST NOT produce the `opening_button` warning, and a new
opening SHALL keep defaulting to `text`.

#### Scenario: Opening with a quick reply
- **GIVEN** an opening in quick mode titled "Quero ver as opções"
- **WHEN** a matching comment starts a run
- **THEN** the private reply carries the text with the reply hint and one quick reply "Quero ver as
  opções", and no buttons

#### Scenario: Participant in Message Requests types instead of tapping
- **GIVEN** a run waiting on an opening in quick mode
- **WHEN** the participant types "oi"
- **THEN** the run follows the opening's `next` output

#### Scenario: No warning for quick mode
- **WHEN** a member activates a valid flow whose opening is in quick mode
- **THEN** the status changes and the response lists no `opening_button` warning
