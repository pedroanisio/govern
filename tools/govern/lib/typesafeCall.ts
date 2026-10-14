// One HTTP call to TypeSafe, run by lib/decide.ts as a child process because govern is synchronous: reads {url, body,
// timeoutMs} as JSON on stdin, posts body to url with TYPESAFE_API_KEY (from the environment, never argv) as a bearer
// token, and prints {status, text} or {error} as JSON on stdout.
const chunks: Buffer[] = [];
process.stdin.on("data", (c) => chunks.push(c as Buffer));
process.stdin.on("end", async () => {
  const { url, body, timeoutMs } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { url: string; body: unknown; timeoutMs: number };
  try {
    const r = await fetch(url, {
      method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${process.env.TYPESAFE_API_KEY ?? ""}`, "content-type": "application/json" },
    });
    process.stdout.write(JSON.stringify({ status: r.status, text: await r.text() }));
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    process.stdout.write(JSON.stringify({ error: `${(e as Error).message}${cause ? ` (${cause})` : ""}` }));
  }
});
