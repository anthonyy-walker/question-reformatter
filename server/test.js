// test.js — end-to-end check of the server with a fake Claude.
// Needs a Postgres in TEST_DATABASE_URL. Run: TEST_DATABASE_URL=postgres://... npm test
const http = require("http");
const { spawn } = require("child_process");
const assert = require("assert");

const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error("Set TEST_DATABASE_URL"); process.exit(1); }

let calls = 0;
const fake = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    calls++;
    const body = JSON.parse(b);
    const fix = body.messages.length > 1;
    // First answer drops the "15%" so the check fails; the fix puts it back.
    const out = {
      summary: "Stores give surprise discounts at checkout.",
      sections: [{ heading: "Who they studied", points: [{ text: "A random sample of US undergrads (⟦M1⟧).", sub: [] }] },
        { heading: "What happened", points: [{ text: fix ? "They got a surprise 15% discount." : "They got a surprise discount.", sub: [] }] }],
      question: ["Is the discount effect not zero?"], choices_intro: "", choices: body.messages[0].content.includes("<choice") ? ["Yes", "No"] : [],
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(out) }], usage: { input_tokens: 1200, output_tokens: 300 } }));
  });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const { Client } = require("pg"); const c = new Client({ connectionString: DB }); await c.connect();
  await c.query("DROP TABLE IF EXISTS rewrites, cache, connections, viewers, settings"); await c.end();
  await new Promise((r) => fake.listen(4555, r));
  const srv = spawn(process.execPath, [__dirname + "/index.js"], {
    env: { ...process.env, PORT: "4556", DATABASE_URL: DB, DASHBOARD_PASSWORD: "test-pass", ANTHROPIC_API_KEY: "x", ANTHROPIC_URL: "http://127.0.0.1:4555/v1/messages" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch("http://127.0.0.1:4556/health"); break; } catch (_) { await wait(100); } }
    const base = "http://127.0.0.1:4556";
    const j = async (r) => ({ status: r.status, body: await r.json() });

    // login
    assert.equal((await j(await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ password: "nope" }) }))).status, 401);
    const lr = await fetch(base + "/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }) });
    assert.equal(lr.status, 200);
    const cookie = lr.headers.get("set-cookie").split(";")[0];
    const A = (p, o = {}) => fetch(base + p, { ...o, headers: { cookie, "content-type": "application/json", ...(o.headers || {}) } }).then(j);
    assert.equal((await j(await fetch(base + "/api/stats"))).status, 401);

    // connection code
    const code = (await A("/api/connections", { method: "POST", body: JSON.stringify({ name: "Test Chrome" }) })).body.token;
    assert.ok(code.startsWith("dra_"));
    const E = (p, body, tok = code) => fetch(base + p, { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);
    assert.equal((await E("/api/ext/ping", {}, "dra_wrong")).status, 401);
    const ping = await E("/api/ext/ping", {});
    assert.equal(ping.body.name, "Test Chrome");

    // reformat: question with a choice list and math
    const q = { kind: "question", site: "www.gradescope.com", pageTitle: "EP 5", text: "Researchers recruited ⟦M1⟧ US college undergraduate students. Each got a surprise 15% discount. Is the effect not zero?", choices: ["Yes", "No"], math: [{ token: "⟦M1⟧", text: "n = 40" }] };
    const r1 = await E("/api/ext/reformat", q);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(calls, 2, "self-fix pass should run");
    assert.ok(JSON.stringify(r1.body.structured).includes("15%"));
    const r2 = await E("/api/ext/reformat", q);
    assert.equal(r2.body.cached, true); assert.equal(calls, 2);

    // reading
    const rd = await E("/api/ext/reformat", { kind: "reading", site: "en.wikipedia.org", text: "Stores give a surprise 15% discount to a random sample of ⟦M1⟧ undergrads at checkout, which is not zero.", math: [{ token: "⟦M1⟧", text: "n = 40" }] });
    assert.equal(rd.status, 200);

    // dashboard data
    const st = (await A("/api/stats?days=30")).body;
    assert.equal(st.total, 3); assert.equal(st.cached, 1); assert.ok(st.cost > 0);
    const list = (await A("/api/rewrites")).body;
    assert.equal(list.total, 3);
    const one = (await A("/api/rewrites/" + list.rows[2].id)).body;
    assert.ok(one.first_problems.length > 0 && one.self_fixed, "first rewrite should record the fixed problem");
    assert.equal((await A("/api/rewrites?q=wikipedia")).body.total, 1);

    // on-device rewrite logged by the extension
    const lg = await E("/api/ext/log", { kind: "reading", site: "umich.instructure.com", text: "A long paragraph about the syllabus that was rewritten on the computer.", model: "on-device", result: { summary: "Syllabus rules.", sections: [] }, firstProblems: ["Numbers missing: 3"], repaired: true, ms: 4100 });
    assert.equal(lg.status, 200);
    const st2 = (await A("/api/stats?days=30")).body;
    assert.equal(st2.total, 4); assert.equal(st2.on_device, 1);
    const top = (await A("/api/rewrites?limit=1")).body.rows[0];
    assert.equal(top.model, "on-device"); assert.equal(top.repaired, true);
    assert.equal((await fetch(base + "/api/view/x/info")).status, 401, "sharing is gone");

    // revoke
    const cid = (await A("/api/connections")).body[0].id;
    await A("/api/connections/" + cid, { method: "DELETE" });
    assert.equal((await E("/api/ext/ping", {})).status, 401);

    // settings + pause
    await A("/api/settings", { method: "PUT", body: JSON.stringify({ paused: true, ownerName: "Anthony" }) });
    assert.equal((await A("/api/settings")).body.paused, true);
    await A("/api/settings", { method: "PUT", body: JSON.stringify({ paused: false }) });

    console.log("All server tests passed.");
  } finally { srv.kill(); fake.close(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
