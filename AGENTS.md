# Non-Negotiable Engineering Rules

## Understand Before Changing

* Read all relevant files before making edits.
* Inspect the existing implementation, tests, helpers, conventions, and surrounding code first.
* Do not invent files, APIs, requirements, assumptions, or expected behavior.
* Confirm that every proposed change directly supports the requested task.

## Validate All Incoming Data

* Treat all data entering the code from an external source or trust boundary as untrusted until validated.
* Every entry point that accepts incoming data must have an appropriate validation method, schema, or equivalent runtime check.
* Validate incoming data as close as possible to where it enters the system.
* Complete validation before the data reaches business logic, storage, file operations, command execution, rendering, logging, or external services.
* Incoming data includes, but is not limited to:

  * HTTP request bodies, route parameters, query parameters, headers, cookies, and uploaded files.
  * Form submissions and other user-entered values.
  * Command-line arguments and standard input.
  * Webhooks, messages, events, queues, and socket data.
  * Third-party API requests and responses.
  * Imported files, parsed documents, and serialized data.
  * Database results that cross a trust boundary.
  * Environment variables and configuration values.
  * Data received from clients, integrations, plugins, extensions, and other services.
* Use the project's existing validation libraries, schemas, types, helpers, and error-handling conventions.
* Reuse or centralize validation methods when the same data structure enters the system through multiple paths.
* Do not rely on static types, client-side validation, documentation, or upstream validation as proof that runtime data is valid.
* Validate required fields, data types, structure, formats, allowed values, ranges, lengths, sizes, encoding, and relationships between fields where applicable.
* Reject unexpected fields when the input contract defines a strict schema.
* Apply explicit size and complexity limits to strings, collections, files, nested objects, and payloads where unbounded input could cause failure or abuse.
* Use safe parsing methods and handle parsing failures explicitly.
* Normalize or sanitize input only when required by the established contract.
* Keep normalization and sanitization separate from validation where practical.
* Do not silently coerce, repair, default, truncate, discard, or reinterpret invalid data unless that behavior is explicitly required and tested.
* Validate authentication, authorization, ownership, permissions, request integrity, and replay protection where applicable.
* Return or propagate clear and consistent validation errors without exposing secrets or sensitive internal details.
* Ensure invalid or unverified data cannot reach business logic, database operations, filesystem operations, command execution, templates, logs, or external services.
* Add or update tests for valid, invalid, missing, malformed, unexpected, oversized, boundary, and unauthorized inputs where applicable.
* If the expected input contract cannot be determined or verified, stop and record the uncertainty or blocker instead of inventing validation rules.

## Keep the Scope Strict

* Make the smallest safe change that fully solves the problem.
* Only edit files that are directly related to the task.
* Do not create new files, abstractions, helpers, utilities, or configuration unless they are necessary.
* Do not refactor, clean up, rename, reorganize, or improve unrelated code.
* Do not change APIs, routes, configuration, data formats, or existing behavior unless the task requires it.
* Match the project's existing style, naming, architecture, and patterns.
* Prefer existing helpers and utilities over introducing new ones.

## Every Change Must Be Justified

* Every code change must have a clear, task-specific reason.
* Do not add code for hypothetical future use.
* Do not add defensive logic without an identified failure case.
* Do not introduce abstractions unless they reduce necessary duplication or are required by the current task.
* Remove any proposed change that cannot be directly tied to a requirement, bug, test, or verified behavior.
* Comments should explain why something is necessary, not restate what the code does.

## Dependencies and Sensitive Files

* Do not add dependencies unless the task cannot be completed safely with the existing stack.
* Do not modify lockfiles unless dependencies were intentionally changed.
* Do not edit secrets, `.env` files, tokens, keys, credentials, or generated sensitive values.
* Preserve all existing authentication, authorization, validation, and security checks.

## Progress Tracking Is Required

* Create a `TASK_PROGRESS.md` file in the repository root to keep track of where the task currently stands.
* Record the task objective and current status.
* List all relevant files inspected.
* List every file created, modified, or deleted.
* Record what has been completed and what still needs to be done.
* Record tests added or updated.
* Record tests run and their results.
* Record any blockers, unresolved questions, assumptions, limitations, or remaining risks.
* Update the file after every meaningful change and before ending the work session.
* Keep the file concise, factual, and up to date.
* Do not include secrets, tokens, keys, credentials, or other sensitive values.

## Changelog Is Required

* Create a `CHANGELOG.md` file in the repository root if one does not already exist.
* Record completed changes that affect users, integrations, APIs, configuration, data formats, deployment, or documented behavior.
* Group changes under clear version or date headings.
* Categorize entries when appropriate, such as Added, Changed, Fixed, Deprecated, Removed, or Security.
* Write entries in clear language that explains what changed and why it matters.
* Do not include unfinished work, investigation notes, temporary implementation details, or internal progress updates.
* Do not duplicate the contents of `TASK_PROGRESS.md`.
* Update the changelog before completing any task that introduces a changelog-worthy change.
* Do not rewrite or remove existing changelog history unless explicitly asked.

## Testing Is Required

* Identify the relevant test method before or while implementing the change.
* Add or update tests whenever behavior changes, a bug is fixed, or a new case is supported.
* Test the specific behavior being changed, including relevant edge cases and failure paths.
* Prefer focused tests that prove the requirement rather than broad or unrelated test changes.
* Run the most relevant tests after each meaningful change when practical.
* Run broader regression tests when the change could affect shared behavior.
* Do not weaken, remove, skip, or rewrite failing tests merely to make the suite pass.
* If a test fails, investigate whether the implementation or the test is incorrect before changing either.
* If tests cannot be run, clearly state what was not tested and why.
* Do not claim that code works unless it was tested or the limitation is explicitly stated.

## Git and Repository Safety

* Do not commit unless explicitly asked.
* Do not rewrite, reset, rebase, or otherwise change git history.
* Do not discard existing user changes.
* Do not modify generated files unless the task specifically requires regeneration.
* Never add `Co-Authored-By` or any AI attribution lines.
* Never add Claude attribution to PR descriptions.
* Commit message format: `[type]: [description]`

## Final Response Requirements

The final response must include:

* What changed and why.
* Every file changed.
* Tests added or updated.
* Tests run and their results.
* Anything not tested or not completed.
* Any assumptions, limitations, or remaining risks.
* Confirmation that `TASK_PROGRESS.md` is up to date.
* Confirmation that `CHANGELOG.md` was updated when required.