# Loops and dynamic branching

Govern supports bounded correction cycles, conditional parallel branches, and one subprocess per collection item. They use the existing `advance`, `data`, `subprocess`, and `tick --advance` commands. Execution is explicit; there is no background scheduler implied by these definitions.

## Repeat a stage or a scoped body

A repeat route declares its entry, body, and maximum total iterations:

```json
{"name":"review","next":[
  {"to":["draft"],"when":{"field":"needsChanges","op":"eq","value":true},
   "loop":{"maxIterations":3,"stages":["draft","review"]}},
  {"to":["publish"]}
]}
```

`draft` must lead to `review`. The first execution counts as iteration one; this definition permits two repeats. At the limit, a still-selected repeat refuses advancement and preserves the case. Change the decision data or resolve the process explicitly. Conditions are evaluated on advancement; a loop can target itself.

A bound alone lets a loop spend every round redoing the same work: a reviewer repeats the same finding, the author cannot satisfy it, and the case only stops at the limit. `stallOn` names the case fields that show a round made progress (a diff hash, a findings digest, a version):

```json
"loop":{"maxIterations":4,"stages":["build","review"],"stallOn":["diffSha"]}
```

Each repeat records those fields. When the repeat is selected again and every `stallOn` field is set and equal to what the previous repeat recorded, the advance is refused (`loop review would repeat with diffSha unchanged since its last round`) and the case stays where it is, as at the limit: `govern drive` gives the stage to a person, who changes the data or resolves the case. A field that is not set never stalls the loop, so the first round, and a process whose services do not yet write the field, repeat as before. Status shows the recorded values as `loop marks`; nested loops clear their inner marks with their inner budgets.

A repeat clears completion, cancellation, human decisions, and stage gate approvals within the body, including approvals that depend on those gates. It preserves unrelated parallel work and data. Runtime entry generations increment, so an old event receipt cannot satisfy a new iteration. Completed subprocesses remain available as historical cases; a repeated call creates a new invocation. Unfinished subprocesses and uncertain checks or compensation block a repeat. Nested loops reset their inner budgets when the outer body repeats. Rework reroutes retain repeat counters.

Loops must have one entry and one latch (the stage owning the repeat route). Every body stage must be reachable from the entry and reach the latch. Forward paths cannot escape before the latch. Scopes may nest or be disjoint. Ordinary undeclared cycles remain invalid.

## Select multiple branches from case data

```json
{"name":"dispatch","next":[{"to":[],"branches":[
  {"to":"legal","when":{"field":"amount","op":"gte","value":1000}},
  {"to":"security","when":{"field":"sensitive","op":"eq","value":true}}
],"join":"approved"}]}
```

Both branches declare `next: [{"to":["approved"]}]`. The destination declares `join: {"mode":"all","stages":["legal","security"]}`. All matching branches start together. `to` can include branches that always run. The join waits only for selected predecessors; no matches advances directly to the join. Conditions are evaluated once at dispatch and the selected predecessor set is persisted. An `any` join releases after one selected predecessor and cancels remaining paths, but unfinished subprocesses must be resolved first.

Conditional branches currently route directly and unconditionally to their explicit join. For multi-step branch work, make a branch a subprocess. Destinations come from the validated process definition rather than arbitrary data strings.

## Expand a collection into child cases

Declare flat typed collections in `fields`:

```json
{"items":{"type":"array","items":{"type":"string"},"max":100},
 "results":{"type":"array","items":{"type":"string"}}}
```

`items` supports scalar types, enums, and scalar bounds; collection `min` and `max` limit length. `contains` conditions test scalar membership. Nested arrays and object items are not supported.

A stage can expand the collection:

```json
{"name":"fulfill","foreach":{
  "process":"fulfill-item","collection":"items","itemField":"sku",
  "maxItems":100,"concurrency":4,
  "inputs":{"customer":"customer"},"outputs":{"results":"receipt"}
},"next":[]}
```

Input maps are child field → parent field; output maps are parent collection → child scalar field. The child process must define compatible typed fields. `maxItems` is required, at most 10,000; concurrency defaults to four and is at most 256. Concurrency bounds unfinished child cases, not worker processes.

Process validation refuses a foreach when:

- `collection` is not a declared `array` field;
- `process` names the declaring process itself;
- `itemField` is also a key of `inputs`;
- an input source is not a declared parent field;
- an output destination is not a declared parent `array` field, or is the collection or an input source;
- the stage also declares `event` or `call`.

When expansion starts, govern checks the child process and the case data, and refuses to expand when:

- subprocess nesting would exceed 16 levels, or the child process already appears among the case's ancestors;
- the collection is missing or has more than `maxItems` items;
- `itemField` does not name a scalar child field, or an item is not a valid value for it;
- an input names no child field, or its parent source is missing or not a valid value for that child field;
- an output source is not a scalar child field of the collection's `items` type, or the item count is outside the output field's `min` and `max`.

`govern subprocess <case>` starts available items and synchronizes finished children. Finish each child through its normal gates, then synchronize again; `advance` and `tick --advance` also synchronize. Outputs retain input order, including duplicate input values. An empty collection completes immediately with empty output arrays.

The collection and mapped inputs freeze when expansion starts. All children use one pinned process snapshot, including children launched later. Indexed invocation paths allow recovery after an interrupted launch without duplicating a case. Expansion state persists across command invocations. Migration and exception reroutes refuse unfinished item batches. Child failure handling remains part of the child's process: a batch waits for every child to finish rather than automatically abandoning failed work.
