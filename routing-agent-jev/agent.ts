import {
  DEFAULT_ROUTE,
  LlmAgent,
  Workflow,
  createEvent,
  node,
  type NodeContext,
} from "@google/adk";
import { TypeSafeClient, choice } from "@typesafe-ai/sdk";

// The same Ollivanders front desk as routing-agent/agent.ts, with one change:
// the classifier is no longer a Gemini LlmAgent with an outputSchema. It is a
// single TypeSafe AI Jev call that returns a probability for every route, and
// plain code turns those numbers into a route. The specialists and the graph
// are unchanged.

// --- Specialists ---
// Identical to routing-agent/agent.ts. They have no idea how they were picked.

const wandSpecialist = new LlmAgent({
  name: "WandSpecialist",
  model: "gemini-3.8-flash",
  description:
    "Answers questions about wand products: woods, cores, lengths, what to buy, how wands differ.",
  instruction: `You are a wand specialist at Ollivanders. Answer questions about
wand products — woods, cores, lengths, flexibility, and which wand suits which wizard.

Reference this catalogue when relevant:
- Holly, phoenix feather, 11"
- Yew, phoenix feather, 13.5"
- Elder, thestral tail hair, 15"
- Vine, dragon heartstring, 10.75"
- Willow, unicorn hair, 10.25"

Be concise and stay in character.`,
});

const magicalTechnician = new LlmAgent({
  name: "MagicalTechnician",
  model: "gemini-3.8-flash",
  description:
    "Diagnoses and repairs malfunctioning wands: wrong spells firing, damage, contamination, unresponsive cores.",
  instruction: `You are a magical technician at Ollivanders. Diagnose and
recommend a fix for malfunctioning wands — wrong spells firing, physical damage,
contamination, unresponsive cores, backfiring charms.

Ask one clarifying question if the symptom is vague, then give a short
diagnosis and a recommended next step. Be concise and stay in character.`,
});

// --- Router ---
// In routing-agent/agent.ts this took two nodes: a classifier LlmAgent that
// wrote JSON, and a `dispatch` function that lifted the verdict into
// `event.route`. Here one node does both. Jev answers a `choice` question with
// a probability per label and a confidence, so the route is decided by code
// you can read, with a threshold you can tune. No JSON parsing, no prose.
//
// The client is created on first use rather than at import time, so a missing
// TYPESAFE_API_KEY fails on the first message, after `adk` has loaded `.env`.

let client: TypeSafeClient | undefined;
const jev = () => (client ??= new TypeSafeClient()); // reads TYPESAFE_API_KEY

// Below this confidence the router asks instead of guessing. A wrong route
// costs the customer a useless answer; a question costs them one more message.
const MIN_CONFIDENCE = 0.6;

const userText = (ctx: NodeContext) =>
  ctx.invocationContext.userContent?.parts?.map((p) => p.text ?? "").join("") ?? "";

const router = node(
  async (ctx: NodeContext) => {
    const message = userText(ctx);
    const { answers } = await jev().systemOne({
      state: message,
      questions: {
        route: choice("Which Ollivanders desk should handle this customer message?", {
          PRODUCT: "Choosing or buying a wand: woods, cores, lengths, which wand suits whom.",
          REPAIR: "A wand that misbehaves, sparks, backfires, is damaged or contaminated.",
          OTHER: "Anything that is not about wands.",
        }),
      },
    });

    const { route } = answers;
    const decided = route.confidence < MIN_CONFIDENCE ? "CLARIFY" : route.choice;

    // The numbers are the point of the demo, so print them next to the trace.
    const probs = Object.entries(route.probabilities)
      .map(([label, p]) => `${label} ${p.toFixed(2)}`)
      .join("  ");
    console.log(`[jev] ${probs}  -> ${decided}`);

    // OTHER has no key in the routing map, so it falls through to DEFAULT_ROUTE.
    return createEvent({ route: decided, output: message });
  },
  { name: "jev_router" },
);

// --- Fallbacks ---

const clarify = node(
  () =>
    "Happy to help — are you looking to choose a new wand, or is your current wand misbehaving?",
  { name: "clarify" },
);

const redirect = node(
  () =>
    "I only handle wand questions — could you rephrase that as something about choosing or repairing a wand?",
  { name: "redirect" },
);

// --- The graph ---
// Every turn starts at START, so the reply to `clarify` goes back through the
// router with the customer's new wording.

export const rootAgent = new Workflow({
  name: "OllivandersFrontDeskJev",
  edges: [
    ["START", router],
    [
      router,
      {
        PRODUCT: wandSpecialist,
        REPAIR: magicalTechnician,
        CLARIFY: clarify,
        [DEFAULT_ROUTE]: redirect,
      },
    ],
  ],
});
