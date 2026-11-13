# Task queue

The renderer owns one session queue per storage workspace. It runs tasks serially and keeps them
alive when a dialog, directory, or queue panel closes. Registered tasks include rename and deletion.

## Contracts and execution

`tasks/task-types.ts` defines the common request, state, failure, progress, and handler contracts.
`TaskQueue<Definitions>` takes a type map associating each task's input with its result and a handler
for every registered type. The queue does not interpret storage entries or storage errors.

Handlers provide opaque resource conflict keys, execute an operation, map failures to safe codes
and translation descriptors, and optionally handle success or failure. An enqueue is rejected when
its keys overlap any queued or running task. Keys are released when the task finishes.

The queue catches result-hook errors and continues processing. A successful operation remains
successful even when its result hook fails. Rename's success hook applies the result to the directory
cache; if applying it throws, it invalidates the affected connection's cache so its listings reload.
Logs omit the underlying error, which may contain provider details.

Handlers can report determinate or indeterminate progress through `TaskContext.reportProgress`.
Reports only update the matching running task; callbacks after completion or clearing are ignored.
Rename does not report progress. Requests, results, and progress must remain data snapshots;
credentials, executable callbacks, React elements, and SDK objects do not belong in them.

## Presentation and directory integration

The workspace passes the queue and its presenter to `TaskQueueDock`. `TaskQueuePanel` and
`TaskQueueRow` use common presentation models rather than inspecting task inputs. Labels and
failures are translated when rendered, so changing languages also updates existing task rows.
Optional row actions contain actual UI callbacks and live only in the derived presentation model.
They are not stored in task snapshots. Rename currently supplies no row actions.

`storage/tasks/` owns storage task input/result definitions, handlers, presenter, and the typed storage
queue context. `selectPendingEntryEffects` projects active tasks into directory-specific busy states
and optimistic names. Directory listings consume those effects without reading task inputs.

Single-file deletion requires confirmation that deletion cannot be undone. The service and menu
use the common remove operation and capability without distinguishing providers. Each adapter
owns its implementation: Google Drive maps remove to files.update with trashed=true and derives
its remove capability from canTrash, for both shared drives and My Drive. It never sends a
permanent deletion request. Local storage uses unlink without following links. Drive deletion
validates the selected drive and entry kind. Folder deletion is not exposed.
Deletion shares conflict keys with rename and locks other writes until it finishes.
Successful deletion removes the entry from cached and open listings; an in-flight listing reloads
so an older response cannot restore the deleted row. Failures keep the entry and appear in the queue.

Adding a task requires extending the storage type map, registering its handler, providing its
presentation, and defining any directory effects. The queue and common row layout remain shared.
Concurrency, persistent recovery, and a main-process task service are separate future work.
