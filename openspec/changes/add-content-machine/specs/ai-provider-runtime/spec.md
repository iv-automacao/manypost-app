## ADDED Requirements

### Requirement: Chat-completions request shape is configurable for reasoning-family models

The chat-completions adapter SHALL send the output-token limit under the parameter name configured
for the installation, defaulting to `max_tokens`, and SHALL omit `temperature` when the installation
disables it, defaulting to sending it. The configuration SHALL be resolved from the environment by the
same mapping used by the API and the worker.

#### Scenario: Default request shape is unchanged
- **WHEN** no token-parameter or temperature setting is configured
- **THEN** the request carries `max_tokens` and the temperature exactly as before

#### Scenario: Reasoning-family model
- **WHEN** the installation configures the limit parameter as `max_completion_tokens` and disables temperature
- **THEN** the request carries `max_completion_tokens` with the cap and no `temperature`
