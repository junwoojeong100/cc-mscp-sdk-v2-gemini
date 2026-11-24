import { createCopilotClient } from "./copilot-client.mjs";
import { resolveCopilotHome } from "./copilot-home.mjs";
import { adapterModels, PRIMARY_MODELS, supportedReasoningEfforts } from "./model-map.mjs";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const all = args.has("--all");

const number = (value) => (Number.isFinite(value) ? value.toLocaleString("en-US") : "-");

function row(model) {
  const limits = model.capabilities?.limits ?? {};
  return {
    id: model.id,
    name: model.name || "",
    // A model with no policy entry needs no opt-in; "enabled" is an opt-in already given.
    policy: model.policy?.state ?? "-",
    context: number(limits.max_context_window_tokens),
    output: number(limits.max_output_tokens),
    vision: model.capabilities?.supports?.vision ? "yes" : "no",
    effort: supportedReasoningEfforts(model).join(",") || "-",
  };
}

function printTable(rows) {
  const columns = [
    ["ID", "id"],
    ["NAME", "name"],
    ["POLICY", "policy"],
    ["CONTEXT", "context"],
    ["OUTPUT", "output"],
    ["VISION", "vision"],
    ["EFFORT", "effort"],
  ];
  const widths = columns.map(([title, key]) => Math.max(title.length, ...rows.map((r) => String(r[key]).length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ").trimEnd();
  console.log(line(columns.map(([title]) => title)));
  for (const r of rows) console.log(line(columns.map(([, key]) => r[key])));
}

const client = createCopilotClient({
  baseDirectory: resolveCopilotHome(process.env.COPILOT_HOME),
  logLevel: "error",
});

try {
  await client.start();
  const auth = await client.getAuthStatus();
  if (!auth.isAuthenticated) {
    console.error("Not signed in to GitHub Copilot. Run: copilot login");
    process.exitCode = 1;
  } else {
    const catalog = adapterModels(await client.listModels());
    const selected = all ? catalog : catalog.filter((model) => PRIMARY_MODELS.includes(model.id));
    if (json) {
      console.log(JSON.stringify(selected, null, 2));
    } else {
      console.log(`Signed in as ${auth.login} (${auth.host})\n`);
      printTable(selected.map(row));
      const missing = PRIMARY_MODELS.filter((id) => !catalog.some((model) => model.id === id));
      for (const id of missing) console.log(`${id}: not in this account's catalog`);
      const notes = selected.flatMap((model) => [
        ...(model.infoMessages ?? []).map((info) => `- ${model.id}: ${info.message}`),
        ...(model.warningMessages ?? []).map((warning) => `- ${model.id}: warning: ${warning.message}`),
      ]);
      if (notes.length) console.log(`\nNotes\n${notes.join("\n")}`);
    }
    if (!PRIMARY_MODELS.some((id) => catalog.some((model) => model.id === id))) process.exitCode = 1;
  }
} finally {
  await client.stop().catch(() => {});
}
