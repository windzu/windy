# Windy streaming architecture

## 1. Overview

Windy must present Codex work inside Obsidian without making the provider wait
for UI rendering or progress persistence. The streaming path therefore treats
provider events, durable conversation state, UI snapshots, and checkpoints as
separate concerns with explicit rate and reliability contracts.

This design covers active-turn streaming. It does not change Codex model
selection, tool semantics, conversation history compatibility, or the final
answer format.

## 2. Current state

The original path applied every provider delta directly to the persisted
conversation, cloned the full conversation for a snapshot, rebuilt the full
Windy view, and attempted a full JSON checkpoint every 250 milliseconds.

Observed on a long-running local conversation:

- 21,854 assistant text characters were represented by 13,079 content blocks.
- One final answer arrived as 478 text deltas averaging two characters each.
- The Windy conversation document reached 2.7 MiB.
- Codex reported completion 28.9 seconds before Windy reported completion.

The delay is local queue drain time, not model execution time.

## 3. Technical design

```mermaid
flowchart TB
    A["Codex app-server\nnotifications"] --> B["Provider normalizer"]
    B --> C["Turn controller\nmutable active state"]
    C --> D["Delta coalescer\npreserve semantic order"]
    D --> E["Snapshot scheduler\nmax 10 Hz"]
    D --> F["Checkpoint scheduler\nmax 1 Hz"]
    E --> G["Obsidian view"]
    F --> H["Conversation repository"]
    C --> I["Terminal transition"]
    I --> G
    I --> H
```

### 3.1 Provider ingestion

Provider notification handlers normalize protocol events into provider-neutral
`StreamChunk` values. Ingestion must not await view rendering or progress
checkpoint I/O. Buffered chunks are drained in batches rather than with
repeated `Array.shift()` operations.

### 3.2 Active-turn state

`ConversationTaskController` remains the owner of mutable active-turn state.
Adjacent `text` and `thinking` deltas are appended to the latest compatible
content block. A tool, context-compaction, or different block type creates a
semantic boundary, so activity order remains lossless.

Assistant text also preserves the provider item id and user-visible phase.
`commentary` participates in the ordered activity trail; `final_answer`
remains the durable assistant answer used as the primary transcript content.

The accumulated assistant `content` remains the final answer source. Ordered
`contentBlocks` remain the activity source; they store semantic segments rather
than transport packet boundaries.

### 3.3 Queued and steered user turns

Submitting while a conversation is `running`, `waiting-approval`, or
`waiting-input` persists a `queuedTurns` entry instead of rejecting the input.
The controller owns one processing loop per conversation and removes each
queued entry in FIFO order only when it creates the corresponding persisted
user/assistant turn pair. This keeps rerenders and concurrent submits from
starting duplicate queries.

For runtimes that implement `ChatRuntime.steer`, the UI may request immediate
delivery after explicit user confirmation. The queued entry remains durable
until the provider accepts the steer. On acceptance it is removed from the
FIFO and recorded as an interrupt user message. The next provider assistant
message boundary starts a new assistant segment after that interrupt, while
the original query stream remains active.

A queued entry may also be undone before steering begins. Removal is persisted
before the card disappears; a failed write restores the entry at its original
FIFO position. An entry already being steered cannot be undone because provider
acceptance is the ownership boundary.

### 3.4 Snapshot scheduling

Progress snapshots are coalesced to at most one update every 100 milliseconds.
This bounds full-conversation cloning and current full-view rendering to 10 Hz.
Approval, user-input, cancellation, failure, and terminal transitions bypass
the scheduler and emit immediately.

Transcript contents still use the bounded full renderer, but the keyed composer
DOM node remains mounted for every snapshot of the same conversation. Snapshot
updates patch its status controls in place, preserving browser focus, caret,
IME composition, references, files, and draft state.

### 3.5 Checkpoint scheduling

Progress checkpoints are best-effort recovery data:

- schedule at most once every 1,000 milliseconds;
- never await a progress checkpoint in the chunk-consumption loop;
- preserve invocation order in the repository write queue;
- do not fail the active turn when a progress checkpoint fails.

The terminal save is authoritative and remains awaited before the turn is
reported as durably complete.

### 3.6 Terminal behavior

Terminal state cancels any pending progress snapshot and emits the latest state
immediately. The final save contains all coalesced content, tool results, usage,
provider session metadata, duration, and terminal status.

The active elapsed-time label derives from the persisted turn start time. Its
one-second UI clock patches only the label, does not publish a runtime snapshot,
and does not write a progress checkpoint. Terminal transitions replace it with
the authoritative stored duration.

## 4. Alternatives

| Option | Advantages | Disadvantages | Decision |
|---|---|---|---|
| Persist and render every delta | Simplest state flow | Unbounded local work; provider completion can sit behind UI and I/O backlog | Rejected |
| Debounce until streaming stops | Minimal updates | UI appears frozen during long generations | Rejected |
| Rate-limited snapshots and checkpoints | Bounded cost; preserves live progress and recovery | Full renderer still has a bounded recurring cost | Selected |
| Immediate keyed transcript DOM rewrite | Best theoretical UI efficiency | Couples a state-machine change with a high-risk view rewrite | Follow-up phase |

## 5. Implementation plan

### Phase 1: bound the streaming hot path

- Coalesce adjacent content deltas.
- Rate-limit progress snapshots to 100 milliseconds.
- Make one-second progress checkpoints non-blocking.
- Drain provider buffers in batches.
- Keep all state transitions and final persistence immediate and reliable.

### Phase 2: incremental transcript rendering

- Keep the Windy shell, header, history control, and composer mounted.
- Keep the transcript scrolling surface mounted across progress snapshots so
  an active wheel or trackpad gesture retains the same event target.
- Treat automatic following as a user-controlled state: upward intent pauses
  it, and only returning to the bottom or activating `Back to latest` resumes
  it.
- Reconcile messages by stable message id.
- Patch only the active assistant content and current activity item.
- Render terminal Markdown once when the turn completes.

## 6. Acceptance criteria

- Codex `task_complete` to Windy terminal-state delay is below one second for a
  1,500-delta turn on a 3 MiB conversation.
- Five hundred synchronous text deltas produce no more than five observable
  runtime snapshots before terminal completion.
- Adjacent text or thinking packets produce one semantic content block.
- Progress checkpoint latency does not block provider chunk consumption.
- Approval, user-input, cancellation, error, and completion states remain
  immediately observable.
- Progress snapshots and terminal transitions do not move a transcript whose
  user has suspended automatic following.
- The active transcript scroll container retains object identity across
  progress snapshots.
- Interrupted-turn recovery retains all content present at the latest completed
  checkpoint.
- `npm run typecheck && npm test && npm run build` passes.
