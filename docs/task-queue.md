# Task Queue

The main-process application host owns the session queue and storage task orchestration. Tasks continue when a dialog, directory, queue panel, or renderer session closes. Session ownership does not provide persistence across application restarts.

The [task contracts](../src/main/tasks/types.ts) define domain-neutral requests, states, failures, progress, and handlers. The [queue implementation](../src/main/tasks/task-queue.ts) owns scheduling, resource conflict reservations, and concurrency limits. The common queue does not interpret storage entries or provider errors. Shared view contracts in [tasks](../src/shared/tasks.ts) project serializable snapshots, progress, pre-evaluated control availability, and task events to the renderer without leaking internal work references or provider objects.

## Scheduling and Conflicts

Handlers declare an execution category. Categories govern scheduling capacity only; control support and current availability belong to handlers. Each category has an independent concurrency limit, so a full category does not block another. Tasks start in enqueue order within a category. Execution and its result hook occupy the slot until both settle, whether the task succeeds or fails.

Task groups belong to the common queue. They organize membership and aggregate outcomes without owning execution capacity. Member tasks share the same scheduling budget as standalone tasks, including when a group mixes categories. Business integrations own task discovery and resource preparation; backend orchestration must not introduce an independent pool of content transfers.

Task execution state and group lifecycle and outcomes are separate contracts. Shared visual statuses are presentation projections and do not define resource ownership or completion.

Groups may own preparation that discovers and prepares member work. Preparation has bounded capacity independent of task execution slots, applies backpressure to admission, and shares the queue's cancellation lifetime. Preparation and member execution can overlap. Completion requires terminal preparation and settled members, so an empty work list alone cannot establish completion. Resource reservations distinguish a group's own members from unrelated work and remain owned through settlement. Group history retains its members until the group can be cleared as a whole.

Handlers supply opaque resource conflict keys. Enqueue rejects overlap with queued or running work; keys remain reserved until the task finishes. Storage handlers must agree on keys for operations that cannot safely overlap.

Result-hook failure must not turn an already successful storage operation into a failed task or stop queue processing. Result handlers emit directory change notifications so open renderer caches apply updates or invalidate affected listings if applying a change fails. Logs omit raw errors that could contain provider details.

Progress can be determinate or indeterminate. Control availability is independent of progress; the queue does not interpret or rewrite task-specific measurements. Only reports for the matching running task may update its state; late callbacks must not recreate completed or cleared rows.

Expected lifecycle outcomes are values, distinct from operational failures. Handlers are authoritative about execution outcomes; control-request acknowledgements do not establish those outcomes. Provider-specific interruption signals are translated by task integrations before reaching the common queue.

Cancellation is cooperative. Resource reservations and execution slots remain owned until execution and cleanup settle. A committed result takes precedence over a late cancellation request. The transfer service owns internal transfer lifecycle and local destination safety; the main-process [storage task service](../src/main/services/storage-task-service.ts) owns session membership, group discovery, and destination reservations. Uncommitted overwrite confirmations are scoped to the originating renderer session and are released when that session navigates or closes, while committed queue tasks continue independently.

Transfer suspension is cooperative. Suspension releases execution capacity after the backend settles its reads and writes, while retaining conflict and destination reservations. A suspended task remains unfinished. Resuming preserves task identity and requires another scheduling opportunity. Backend services own partial content and source-integrity checks; byte-level resumability requires range access and verifiable content identity. Session suspension does not provide recovery across application restarts.

Local destination policies distinguish exclusive creation from replacement. Exclusive creation does not promise that only complete content is visible; replacement preserves the existing file until commit. Session cleanup is best effort and must not remove a destination that no longer refers to the task's own creation. Abnormal shutdown can leave unfinished local content because session tasks have no durable recovery state.

## Data and Presentation Boundaries

Requests, results, and progress remain serializable data snapshots. Task and group integrations supply message descriptors and business inputs; renderer presenters convert snapshots into common row models. Credentials, executable callbacks, internal work references, React elements, and SDK objects do not belong in shared task snapshots. Presentation models contain display data only. The common queue UI owns task controls based on pre-evaluated control availability; task integrations cannot add custom controls.

Group presentation and outcome aggregation remain independent of business types. Preparation progress and issues are distinct from member task results, including when preparation produces no members. Aggregate progress uses compatible measurements and does not add unlike units. Tasks identify stable work rather than a particular execution instance. Download planning owns source snapshots and destination mappings for standalone and grouped tasks alike; backend transfer instances belong to executions. Membership does not change a task's execution contract. Retry policy belongs to each task integration and must retain committed results and destination mappings. Backend planning records share the lifetime of their session's task history; clearing history releases those records without undoing committed content.

The [storage task service](../src/main/services/storage-task-service.ts) owns storage-specific handlers, failure mapping, directory discovery, and directory-change events, while [storage task presentation](../src/renderer/src/storage/tasks/storage-task-presenter.ts) and [the storage task client](../src/renderer/src/storage/tasks/storage-task-client.ts) bridge UI commands and snapshot state cleanly. Common queue rows render message descriptors through an injected translator without importing domain or locale catalogs, so changing languages retranslates existing rows immediately.

Directory effects project active tasks and active groups into busy state and optimistic presentation. Listings consume those effects rather than interpreting task inputs directly. Successful changes must update cached and open listings, and an older in-flight response must not restore stale entries. Failures preserve the original listing state and appear in the queue.

## Storage Operations and Extension

Rename and deletion share conflict keys so conflicting writes remain blocked until completion. Deletion tasks are restricted to files and links and require explicit confirmation. Backend behavior follows the [storage removal semantics](storage-abstraction.md#capabilities-and-operations); the service and adapter enforce entry eligibility and capabilities.

To add a task, extend the storage task contracts in [tasks](../src/shared/tasks.ts), register the handler and IPC channels in [the task service](../src/main/services/storage-task-service.ts) and [task IPC](../src/main/task-ipc.ts), update the renderer client and presentation, and define directory effects where needed.
