import { test } from "node:test";
import assert from "node:assert/strict";
import { installSystemUnit } from "../lib/dispatch-service.ts";

test("non-root system service write is refused and prints the complete unit without writing", () => {
  let writes = 0;
  const text = installSystemUnit("[Service]\nUser=tester\n", true, 1000, () => { writes++; });
  assert.equal(writes, 0);
  assert.match(text, /requires root/);
  assert.match(text, /\[Service\]\nUser=tester/);
});
test("root system service write targets the standard unit path", () => {
  const writes: [string, string][] = [];
  const text = installSystemUnit("UNIT", true, 0, (path, unit) => { writes.push([path, unit]); });
  assert.deepEqual(writes, [["/etc/systemd/system/govern-dispatch.service", "UNIT"]]);
  assert.match(text, /systemctl daemon-reload/);
});
