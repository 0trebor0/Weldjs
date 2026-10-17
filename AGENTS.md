# Non-Negotiable Engineering Rules

## Understand Before Changing

* Read all relevant files before making edits.
* Inspect the existing implementation, tests, helpers, conventions, and surrounding code first.
* Do not invent files, APIs, requirements, assumptions, or expected behavior.
* Confirm that every proposed change directly supports the requested task.
* If the task description conflicts with what the code actually does, flag the discrepancy before proceeding rather than assuming either is correct.
* Check for related open branches, PRs, or in-progress work that might overlap before starting.

## Keep the Scope Strict

* Make the smallest safe change that fully solves the problem.
* Only edit files that are directly related to the task.
* Do not create new files, abstractions, helpers, utilities, or configuration unless they are necessary.
* Do not refactor, clean up, rename, reorganize, or improve unrelated code.
* Do not change APIs, routes, configuration, data formats, or existing behavior unless the task requires it.
* Match the project's existing style, naming, architecture, and patterns.
* Prefer existing helpers and utilities over introducing new ones.
* If strict scope conflicts with correctness (e.g. a correct fix requires touching a file outside the stated scope), stop and flag it rather than silently expanding scope or leaving the task half-fixed.

## Repository / Working Directory Lock

* The agent must remain in the repository and working directory where the task is being performed for the entire task.
* Never leave, switch, or operate from another repository, project, workspace, or unrelated directory.
* All file inspection, edits, tests, builds, git commands, and other task-related operations must be executed within the active working directory.
* Do not search for or modify files outside the active working directory unless the task explicitly requires it and the user approves the scope expansion first.
* Before performing any operation that depends on the current directory, verify that the agent is still operating inside the original working directory.
* Do not automatically change to a parent directory, sibling directory, home directory, temporary directory, or another project.
* Do not use files, configuration, dependencies, source code, or git repositories from outside the active working directory to influence the task.
* If a command, tool, script, test runner, build system, or development environment attempts to operate outside the active working directory, stop and assess the situation before continuing.
* If the working directory becomes unavailable, changes unexpectedly, or the agent would need to leave it to continue, stop and report the issue rather than switching directories automatically.
* The original working directory is the task boundary unless the user explicitly approves expanding that boundary.

## No Unrequested Additions

* Do not add new methods, functions, classes, parameters, config options, or exported symbols unless the task explicitly requires them.
* Before adding any new method or function, confirm either: (a) it is actually called somewhere as a result of this change, or (b) the task explicitly asked for a new public API. If neither is true, do not add it.
* Do not add "convenience" overloads, alternate signatures, extra utility methods, or helper abstractions "while you're in there."
* Do not add error handling, logging, retries, or validation for cases outside the task's scope or for pre-existing functions not being modified, even if they seem like good practice. (Newly created functions that have an identifiable failure mode must still meet the baseline in "Error Handling Requirements" below — that baseline is not an unrequested addition.)
* Do not leave in unused methods, variables, imports, or parameters introduced during the change.
* If an addition beyond the stated scope seems genuinely necessary, stop and flag it for confirmation instead of adding it silently.

## Error Handling Requirements

* Every function created that performs an operation with an identifiable failure mode (I/O, network/API calls, parsing, external calls, file/db access, etc.) must include error handling for that failure path — do not leave a new function's error paths unhandled.
* Wrap operations that can fail (I/O, network or API calls, parsing, external/third-party calls, type coercion, file access, database queries) in a try/catch (or the language's equivalent) rather than letting exceptions propagate unhandled.
* Catch specific, expected exception/error types where the language and libraries support it, rather than a bare/blanket catch-all, unless the project's existing conventions already use blanket catches.
* On catching an error, handle it meaningfully — return or raise a clear error, log with enough context to diagnose, or propagate to an existing error-handling layer. Do not swallow errors silently (empty catch blocks).
* Match the project's existing error-handling conventions (custom error classes, error codes, logging utilities) rather than introducing new ones.
* This requirement applies only to newly created functions. It does not authorize adding error handling to unrelated, pre-existing functions outside the task's scope — see "No Unrequested Additions."

## Every Change Must Be Justified

* Every code change must have a clear, task-specific reason.
* Do not add code for hypothetical future use.
* Do not add defensive logic without an identified failure case, except for the baseline error handling required under "Error Handling Requirements" for newly created functions that have an identifiable failure mode.
* Do not introduce abstractions unless they reduce necessary duplication or are required by the current task.
* Remove any proposed change that cannot be directly tied to a requirement, bug, test, or verified behavior.
* Comments should explain why something is necessary, not restate what the code does. Do not strip out pre-existing comments that already follow this rule.

## Write Code People Can Read

* Write code so another developer can understand the change without reconstructing your thought process.
* Use descriptive, consistent names for variables, functions, and types. Avoid abbreviations unless they are already standard in the project.
* Keep control flow straightforward. Use small, focused blocks and functions when they make the required behavior easier to follow; do not split code into helpers solely to reduce line count.
* Format changed code consistently with the project's conventions. Use clear indentation, spacing, and line breaks, and avoid dense one-line expressions or deeply nested logic when a simpler form conveys the same behavior.
* Make assumptions and non-obvious decisions clear at the point where they matter. Add brief comments for the reason behind a choice, while letting clear code explain what it does.
* Prefer the simplest implementation that fully meets the task. Avoid clever shortcuts, unnecessary indirection, and duplicated logic that makes the change harder to maintain.

## Syntax and Build Verification

* After every edit, the affected file(s) must be parsed, linted, or compiled before the change is considered complete — visual inspection of a diff is not sufficient.
* Run the appropriate syntax/build check for the language and project (e.g. `node --check`, `python -m py_compile`, `tsc --noEmit`, `cargo check`, the project's configured lint/build command).
* Run the project's formatter (e.g. `prettier`, `black`, `gofmt`) on changed files if one is configured, rather than relying on manual style matching.
* Confirm the language/runtime version in use matches the project's declared version (e.g. `.nvmrc`, `pyproject.toml`) before running checks, since a mismatched local environment can mask or fabricate errors.
* For any statement spanning or touched by an edit — string concatenation, template literals, multi-line strings — re-read the full statement afterward to confirm quotes, escapes, and delimiters are balanced.
* For structured data (JSON, YAML, function argument lists, object/array literals), explicitly verify commas, matching brackets, and correct nesting before finishing.
* Do not mark a task complete if a syntax/build check was skipped or failed. Either fix the error or state plainly in the final response and in `TASK_PROGRESS.md` that verification could not be completed and why.

## Dependencies and Sensitive Files

* Do not add dependencies unless the task cannot be completed safely with the existing stack. If a new dependency seems necessary, stop and ask before adding it rather than deciding unilaterally.
* Do not modify lockfiles unless dependencies were intentionally changed.
* Do not edit secrets, `.env` files, tokens, keys, credentials, or generated sensitive values.
* Preserve all existing authentication, authorization, validation, and security checks.

## Public API and Compatibility

* Do not change the signature, return type, or behavior of an existing public/exported function unless the task requires it.
* If a change would break an existing caller, flag it explicitly rather than updating call sites silently.

## Documentation Consistency

* If a change alters documented behavior, update the relevant README, docstring, or inline API doc in the same change — don't let `CHANGELOG.md` be the only place behavior changes are recorded.

## Progress Tracking Is Required

* Create a `TASK_PROGRESS.md` file in the repository root to keep track of where the task currently stands.
* Record the task objective and current status.
* List all relevant files inspected.
* List every file created, modified, or deleted.
* Record what has been completed and what still needs to be done.
* Record tests added or updated.
* Record tests run and their results, including syntax/build/lint check output — paste or summarize actual command output, not just a claim that checks passed.
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

* Identify the relevant test method before or while implementing the change. Confirm the project's actual test runner/command before assuming one (e.g. do not assume `npm test` or `pytest` without checking).
* Add or update tests whenever behavior changes, a bug is fixed, or a new case is supported.
* Test the specific behavior being changed, including relevant edge cases and failure paths.
* For newly created functions that include error handling per "Error Handling Requirements," include a test that exercises at least one caught error path (e.g. verify the expected exception is caught and handled as intended), in addition to the normal success-path tests.
* Prefer focused tests that prove the requirement rather than broad or unrelated test changes.
* Run the most relevant tests after each meaningful change when practical.
* Run regression tests scoped to the affected module and its direct dependents when the change could affect shared behavior; do not assume a full-suite run is required unless the change is broad or the project's norms call for it.
* Do not weaken, remove, skip, or rewrite failing tests merely to make the suite pass.
* If a test fails, investigate whether the implementation or the test is incorrect before changing either.
* If a test was already failing before this change, note that it was pre-existing and do not attribute it to this change or silently fix unrelated failures.
* For behavior not fully covered by automated tests (e.g. UI, integration flows), state what manual verification was or wasn't performed.
* If tests cannot be run, clearly state what was not tested and why.
* Do not claim that code works unless it was tested or the limitation is explicitly stated.

## Git and Repository Safety

* Do not commit unless explicitly asked. Leave changes staged or in the working tree, uncommitted, until asked to commit.
* When a commit is made, always commit directly to the main branch — do not create or use feature branches, unless the user explicitly asks for a branch.
* Do not rewrite, reset, rebase, or otherwise change git history.
* Do not discard existing user changes.
* Do not modify generated files unless the task specifically requires regeneration.
* If the working tree has diverged from the target branch (merge conflicts likely), stop and flag rather than force-resolving.
* Respect `CODEOWNERS` or existing review-assignment conventions if present; don't reassign or bypass them.
* Never add Co-Authored-By or any AI attribution lines.
* Never add Claude attribution to PR descriptions.
* Commit message format: `[type]: [description]`

## Failure Handling

* If a change breaks existing behavior or tests mid-task, stop and assess before proceeding further — do not layer additional changes on top of a known-broken state.
* Prefer fixing forward when the cause is understood and the fix is within scope; revert the specific change when the cause is unclear or the fix would expand scope.
* If the task's instructions and this rule set conflict (e.g. user explicitly asks to skip tests or commit directly), state the conflict and ask for confirmation rather than silently picking one side.
* Record the failure, its cause (if known), and the resolution in `TASK_PROGRESS.md`.

## Pre-Completion Checklist

Before finalizing any change, confirm all of the following:

* [ ] Every changed file parses/compiles/lints with no errors
* [ ] Every string, bracket, and delimiter in changed lines is balanced
* [ ] Every newly created function with an identifiable failure mode includes error handling that catches it (see "Error Handling Requirements")
* [ ] No method, function, class, or symbol was added that isn't directly used or explicitly requested
* [ ] No unrelated files were touched
* [ ] No new dependencies were added without flagging them first
* [ ] No public API signature or behavior was changed without being required by the task
* [ ] Relevant documentation was updated if documented behavior changed
* [ ] Tests were run and results recorded, including syntax/build verification
* [ ] `TASK_PROGRESS.md` and `CHANGELOG.md` (if applicable) are up to date

## Final Response Requirements

The final response must include:

* What changed and why.
* Every file changed.
* Tests added or updated.
* Tests run and their results, including syntax/build verification.
* Anything not tested or not completed.
* Any assumptions, limitations, or remaining risks.
* Confirmation that `TASK_PROGRESS.md` is up to date.
* Confirmation that `CHANGELOG.md` was updated when required.
* The git commands to commit and push the change (`git add`, `git commit` with a descriptive message, `git push`), provided for the user to run themselves — per "Git and Repository Safety," do not execute these unless explicitly asked to commit.