# gdg-cloud-oslo-2026

Demo code for **Agents, Workflows, Graphs** — GDG Cloud Oslo 2026.

Everything here runs on [Google ADK](https://github.com/google/adk-js) **2.4**, except `managed-agent`, which calls the [Interactions API](https://aistudio.google.com/docs/interactions-overview) directly through `@google/genai`.

## The demos

| Folder | What it shows |
|---|---|
| `single-agent` | One agent, one `FunctionTool` behind `requireConfirmation`. Star Wars lookup against SWAPI; approve each call. |
| `builtin-tools` | Built-in tools: `GOOGLE_SEARCH` and `URL_CONTEXT`. |
| `sequential-agent` | A `Workflow` chain. The first step is a plain function, not an agent. |
| `parallel-agent` | Fan out to three translators plus a deliberately slow node, then a `JoinNode` barrier: the join fires only once the slow node finishes, and hands the aggregator one object keyed by node name. `npm run start:map` sizes the same fan-out at runtime with `ParallelWorker`. |
| `loop-agent` | Hangman as a loop. A model guesses one letter, a plain function judges it and picks the route: `GUESS` for another lap, `DONE` once the word is solved or the six lives are gone. The word is picked at random and the model never sees it. |
| `routing-agent` | LLM-driven branching in a `Workflow`: a classifier `LlmAgent` with a zod `outputSchema` feeds a `RoutingMap` edge with `DEFAULT_ROUTE` for off-topic messages. The `subAgents` + `transfer_to_agent` version is kept as a foil: `npm run start:transfer`. |
| `routing-agent-jev` | The same graph with the Gemini classifier swapped for one [TypeSafe AI](https://typesafe.ai) Jev `choice` call. Jev returns a probability per route, and plain code picks the route, asking the customer to clarify when confidence is below 0.6. Needs `TYPESAFE_API_KEY` in `.env`. |
| `routing-agent-both` | Questions that are product *and* repair ("it backfires, fix it or buy new?"). Two independent Jev `noul` scores instead of one `choice`; when both pass, the router emits `BOTH`: the technician diagnoses first, the wand specialist answers with that diagnosis (passed through session state via `outputKey`), and a `FrontDesk` agent merges the two into one reply. Needs `TYPESAFE_API_KEY` in `.env`. |
| `agent-as-tool` | `AgentTool`: the mirror of `routing-agent`. The specialist returns, the coordinator answers. `npm run start:nodetool` wraps a whole Workflow as one tool with `NodeTool`; `npm run start:hitl` pauses inside that tool with `RequestInput` and resumes on the next message. |
| `mcp-agent` | Tools from an MCP server. `server.ts` is a plain stdio MCP server that knows nothing about ADK; `MCPToolset` starts it, discovers its tools and hands them to the model. |
| `pr-fixer-agent` | All of the above on a real task. Clones `tpiros/acme-tasks` into a temp folder, reads a GitHub issue, an `LlmAgent` with four sandboxed tools fixes it, a plain `verify` node reruns the tests, `RequestInput` shows you the diagnosis, the fix and the diff and waits for a yes before the PR is opened. Needs `GITHUB_TOKEN` in `.env`. Say `fix issue #1`. See [its README](pr-fixer-agent/README.md) for the full diagram. |
| `managed-agent` | Not ADK: `@google/genai`'s Interactions API directly. A hosted agent in a remote sandbox, no orchestration code. |

## Running one

Every demo needs Node.js 22 or newer (`@google/genai` 3 dropped Node 20), and all of them use `gemini-3.8-flash`.

```bash
cd single-agent
npm install
echo "GEMINI_API_KEY=your-key-here" > .env
npm start          # or: npm run web
```

`npm start` runs the agent in the terminal. `npm run web` opens the ADK dev UI,
where you can watch the tool calls, the event stream and the session state
behind each answer.

## The graph

One `Workflow` covers sequential, parallel and looping work. You declare
`edges`, and the shape falls out of the wiring.

```ts
// sequential
edges: [["START", a, b, c]]

// parallel, with a fan-in barrier
edges: [["START", [fr, es, ja], join, aggregator]]

// a loop is an edge pointing backwards
const judgeNode = node(judge, { name: "judge", inputSchema: GuessSchema });

edges: [
  ["START", setupNode, guesser, judgeNode],
  [judgeNode, { GUESS: guesser, DONE: resultNode, [DEFAULT_ROUTE]: resultNode }],
]
```

Three things worth knowing:

- A graph cycle has no built-in iteration cap. Guaranteeing the exit is your job.
- A route that matches no key ends the run silently, and the dev UI marks the node `NO DEFAULT`. Add `[DEFAULT_ROUTE]` to every routing map.
- `Workflow` still logs that it is experimental and may change (true as of ADK 2.4).
