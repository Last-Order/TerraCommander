# Task Queue

The storage workspace owns a session queue. Tasks continue when a dialog, directory, or queue panel closes. Session ownership does not provide persistence across application restarts.

The [task contracts](../src/renderer/src/tasks/task-types.ts) define requests, states, failures, progress, and handlers. The [queue implementation](../src/renderer/src/tasks/task-queue.ts) owns scheduling and internal concurrency defaults. The common queue does not interpret storage entries or provider errors.

## Scheduling and Conflicts

Handlers declare an execution category. Each category has an independent concurrency limit, so a full category does not block another. Tasks start in enqueue order within a category. Execution and its result hook occupy the slot until both settle, whether the task succeeds or fails.

Handlers supply opaque resource conflict keys. Enqueue rejects overlap with queued or running work; keys remain reserved until the task finishes. Storage handlers must agree on keys for operations that cannot safely overlap.

Result-hook failure must not turn an already successful storage operation into a failed task or stop queue processing. Result handlers apply successful changes to the directory cache and invalidate affected listings if applying a result fails. Logs omit raw errors that could contain provider details.

Progress can be determinate or indeterminate. Only reports for the matching running task may update its state; late callbacks must not recreate completed or cleared rows.

Cancellation is cooperative. Resource reservations and execution slots remain owned until execution and cleanup settle. A committed result takes precedence over a late cancellation request. Transfer resources and local destination safety belong to the backend application service; the renderer queue owns scheduling and presentation. Closing a renderer session releases its backend transfer resources.

Local destination policies distinguish exclusive creation from replacement. Exclusive creation does not promise that only complete content is visible; replacement preserves the existing file until commit. Session cleanup is best effort and must not remove a destination that no longer refers to the task's own creation. Abnormal shutdown can leave unfinished local content because session tasks have no durable recovery state.

## Data and Presentation Boundaries

Requests, results, and progress remain data snapshots. Credentials, executable callbacks, React elements, and SDK objects do not belong in task state. Presentation models contain display data only. The common queue UI owns task controls; task integrations cannot add custom controls.

The [storage task integration](../src/renderer/src/storage/tasks/) owns storage-specific inputs, handlers, failure mapping, and presentation. Common queue rows consume presentation models without inspecting storage task inputs. Translate labels and failure descriptors at render time so changing languages updates existing rows.

Directory effects project active tasks into busy state and optimistic presentation. Listings consume those effects rather than interpreting task inputs directly. Successful changes must update cached and open listings, and an older in-flight response must not restore stale entries. Failures preserve the original listing state and appear in the queue.

## Storage Operations and Extension

Rename and deletion share conflict keys so conflicting writes remain blocked until completion. Deletion tasks are restricted to files and links and require explicit confirmation. Backend behavior follows the [storage removal semantics](storage-abstraction.md#capabilities-and-operations); the service and adapter enforce entry eligibility and capabilities.

To add a task, extend the storage task definitions, register its handler and category, provide presentation, and define directory effects where needed. Registration belongs to the [workspace](../src/renderer/src/storage/StorageWorkspace.tsx). Reuse common scheduling and row presentation, and define conflict keys against existing operations.
