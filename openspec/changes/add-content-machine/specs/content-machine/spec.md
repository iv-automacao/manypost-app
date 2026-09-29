## ADDED Requirements

### Requirement: Content pieces follow a closed, audited lifecycle

The system SHALL model each content piece with exactly one status from the closed set `ideia`,
`roteiro`, `producao`, `revisao`, `aprovado`, `agendado`, `publicado`, `reprovado` and `erro`. A
status SHALL change only through the named transition table, with a conditional update that matches
the organization, the piece and the expected current status. Every transition SHALL append an event
recording the stage, the previous status, the new status and a detail payload.

#### Scenario: Valid automatic transition
- **WHEN** the script stage finishes for a piece in `ideia`
- **THEN** the piece moves to `roteiro` and one event is appended

#### Scenario: Concurrent transition loses
- **WHEN** two workers try to move the same piece from the same status
- **THEN** exactly one update succeeds and the other observes a conflict without side effects

#### Scenario: Invalid transition is refused
- **WHEN** a person asks to move a piece from `publicado` back to `ideia`
- **THEN** the request is refused with `content.invalid_transition` and nothing changes

### Requirement: Every machine record is organization-scoped

The system MUST scope brand, foundation, prompts, pieces, events, spend and hooks by the
organization of the authenticated principal. An identifier supplied by a request SHALL never prove
ownership.

#### Scenario: Another organization's piece is invisible
- **WHEN** a member of organization B requests a piece that belongs to organization A
- **THEN** the system answers not found and organization A's data is not changed

#### Scenario: Unauthenticated access is refused
- **WHEN** a request to a machine route carries no valid human session
- **THEN** the system answers 401

### Requirement: Organizations keep a brand identity with an extracted palette

The system SHALL let an organization store a logo (light and dark variants from its media library),
a color palette, a slogan, a signature line and tone notes. Given a stored logo, the system SHALL
propose a palette extracted from the image; the person MAY edit any color before saving. Rendered
art SHALL use the saved identity.

#### Scenario: Palette proposed from a logo
- **WHEN** a person asks to extract the palette of the organization's logo
- **THEN** the system returns at least three distinct colors ordered by prominence without saving them

#### Scenario: Renderer unavailable
- **WHEN** no renderer is configured
- **THEN** palette extraction and art production are refused with `ai.capability_unavailable`

### Requirement: Foundation and prompts are editable and versioned per organization

The system SHALL store foundation documents under a closed set of keys and prompts by name and
version, with at most one active version per prompt name. Setting up the machine SHALL seed default
foundation templates, prompts and hook formulas once and SHALL be idempotent.

#### Scenario: Setup twice
- **WHEN** setup runs a second time for the same organization
- **THEN** no duplicate foundation, prompt or hook rows are created

### Requirement: A plan creates pieces and stages advance them automatically

The system SHALL create one piece in `ideia` per planned slot carrying the organization's
call-to-action word (one simple uppercase word, a separate word for business audiences, repeated
across pieces so it can be an automation trigger), then execute stages asynchronously: script (script, caption, lint with one
automatic retry carrying the lint findings), production (rendered art, or narrated video scenes
assembled into one vertical video with a closing brand card), review (reviewer answer plus lint)
and scheduling. A stage SHALL persist its result before the next stage is enqueued.

#### Scenario: Lint error on first attempt
- **WHEN** the script stage produces text with a lint error on the first attempt
- **THEN** the piece stays in `ideia` with the findings stored and the stage is retried once

#### Scenario: Review flags a risk
- **WHEN** the reviewer returns any flag or the lint has an error
- **THEN** the piece moves to `revisao` and waits for a person

#### Scenario: Clean review schedules the piece
- **WHEN** the reviewer approves without flags and the lint has no error
- **THEN** the piece moves to `aprovado` and then to `agendado` with a post group created through the existing publishing use cases

#### Scenario: Provider failure
- **WHEN** a generation provider fails or returns no media
- **THEN** the piece moves to `erro` with the message and no success is reported

### Requirement: Stage execution is retry-safe and recovers stuck work

The system SHALL lock a piece while a stage runs and SHALL release the lock when the stage ends. A
periodic sweeper SHALL re-enqueue pieces whose lock expired and SHALL reconcile `agendado` pieces with
the state of their post group (`publicado` when published, `erro` when failed). Re-running a stage
for a piece that already advanced SHALL be a no-op.

#### Scenario: Worker crashed mid-stage
- **WHEN** a piece stays locked beyond the lease
- **THEN** the sweeper re-enqueues it and the stage runs again from the persisted status

#### Scenario: Published post reconciled
- **WHEN** the post group of an `agendado` piece is published
- **THEN** the sweeper moves the piece to `publicado` and stores the permalink

### Requirement: People decide on pieces waiting for review

The system SHALL let a member approve a piece in `revisao` (moving it to `aprovado` and scheduling
it), reject it (moving it to `reprovado`), edit its caption or script, or send it back to an earlier
stage for regeneration.

#### Scenario: Approve after review
- **WHEN** a member approves a piece in `revisao`
- **THEN** the piece moves to `aprovado`, records the approver and is scheduled

### Requirement: Generation cost is recorded

The system SHALL record the monetary cost of each text, image, video and assembly operation with its
provider identifier, attach it to the piece when known, and expose the month-to-date total. A
provider identifier SHALL be recorded at most once.

#### Scenario: Month-to-date spend
- **WHEN** a member opens the spend view
- **THEN** the system shows the total for the current calendar month and the cost per piece
