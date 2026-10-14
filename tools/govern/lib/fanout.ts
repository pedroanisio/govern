// A foreach stage owns a frozen, indexed collection of independently governed child cases.
import { existsSync } from "node:fs";
import { create, load, save, stateFile, appendLedger, type Project } from "./project.ts";
import { getProcess, processOf, freezeProcess, snapshotProcess } from "./process.ts";
import { requireActive, setData } from "./business.ts";
import { runtimeOf, transaction } from "./lifecycle.ts";
import { emptyRecord, check } from "./shape.ts";
import { fieldValue, type Scalar, type Value } from "./business-schema.ts";
import { fail, sha256 } from "./util.ts";

export function syncItems(p: Project, stage: string): boolean {
  requireActive(p, stage);
  const pr = processOf(p),
    f = pr.stages.find((s) => s.name === stage)!.foreach ?? fail(`${stage} has no foreach`),
    r = runtimeOf(p, stage);
  if (r.batch?.synced) return true;
  const target = r.batch ? snapshotProcess(r.batch.snapshot) : getProcess(f.process);
  let ancestor: Project | undefined = p;
  for (let depth = 0; ancestor; depth++) {
    if (depth >= 16) fail("subprocess nesting exceeds 16 levels");
    if (processOf(ancestor).name === target.name) fail("recursive subprocess cycle");
    ancestor = ancestor.invocation ? load(ancestor.invocation.parent) : undefined;
  }
  if (!r.batch) {
    const items = p.data?.[f.collection];
    if (!Array.isArray(items)) fail(`foreach collection ${f.collection} is missing`);
    if (items.length > f.maxItems) fail(`foreach exceeds its ${f.maxItems}-item limit`);
    const itemField = target.fields?.[f.itemField];
    if (!itemField || itemField.type === "array") fail("foreach itemField must name a scalar child field");
    check("foreach items", items, (v, path) => {
      (v as Scalar[]).forEach((x, i) => fieldValue(itemField!, x, `${path}[${i}]`));
      return v;
    });
    for (const [dest, source] of Object.entries(f.inputs ?? {})) {
      if (!target.fields?.[dest] || !Object.hasOwn(p.data ?? {}, source))
        fail(`invalid or missing foreach input ${source}`);
      check("foreach input", p.data![source], (v, path) => {
        fieldValue(target.fields![dest]!, v as Value, path);
        return v;
      });
    }
    for (const [dest, source] of Object.entries(f.outputs ?? {})) {
      const parent = pr.fields![dest]!,
        child = target.fields?.[source];
      if (!child || child.type === "array" || parent.items?.type !== child.type)
        fail(`foreach output ${source} has incompatible type`);
      if ((parent.min ?? 0) > items.length || (parent.max !== undefined && items.length > parent.max))
        fail(`foreach result length cannot satisfy ${dest}`);
    }
    r.batch = { items: [...items], children: emptyRecord(), synced: false, snapshot: freezeProcess(target) };
    save(p);
  }
  const batch = r.batch;
  let available = (f.concurrency ?? 4) - Object.values(batch.children).filter((slug) => !load(slug).finished).length;
  for (let index = 0; index < batch.items.length && available > 0; index++) {
    if (Object.hasOwn(batch.children, String(index))) continue;
    const child = `${p.slug}/__items/${sha256(stage).slice(0, 16)}-${r.generation}-${index}`;
    const invocation = { parent: p.slug, stage, generation: r.generation, itemIndex: index };
    const data = emptyRecord<Value>();
    for (const [dest, source] of Object.entries(f.inputs ?? {})) data[dest] = p.data![source]!;
    data[f.itemField] = batch.items[index]!;
    transaction(child, () => {
      if (existsSync(stateFile(child))) {
        const c = load(child);
        if (
          c.invocation?.parent !== p.slug ||
          c.invocation.stage !== stage ||
          c.invocation.generation !== r.generation ||
          c.invocation.itemIndex !== index
        )
          fail("item case belongs to another invocation");
      } else
        create(child, {
          process: target.name,
          kind: f.kind,
          parent: p.slug,
          snapshot: batch.snapshot,
          data,
          invocation
        });
    });
    batch.children[String(index)] = child;
    available--;
    save(p);
    appendLedger(p.slug, { kind: "foreach-start", stage, child, index, generation: r.generation });
  }
  if (Object.keys(batch.children).length !== batch.items.length) return false;
  const outputs = emptyRecord<Value>();
  for (const dest of Object.keys(f.outputs ?? {})) outputs[dest] = [];
  for (let index = 0; index < batch.items.length; index++) {
    const child = batch.children[String(index)]!;
    const values = transaction(child, () => {
      const c = load(child);
      if (
        c.invocation?.parent !== p.slug ||
        c.invocation.stage !== stage ||
        c.invocation.generation !== r.generation ||
        c.invocation.itemIndex !== index
      )
        fail("item invocation mismatch");
      if (!c.finished) return undefined;
      const values = emptyRecord<Scalar>();
      for (const [dest, source] of Object.entries(f.outputs ?? {})) {
        const v = c.data?.[source];
        if (v === undefined || Array.isArray(v)) fail(`finished item ${index} is missing scalar output ${source}`);
        values[dest] = v;
      }
      return values;
    });
    if (!values) return false;
    for (const [dest, v] of Object.entries(values)) (outputs[dest] as Scalar[]).push(v);
  }
  setData(p, outputs);
  batch.synced = true;
  save(p);
  appendLedger(p.slug, { kind: "foreach-sync", stage, count: batch.items.length, generation: r.generation });
  return true;
}
