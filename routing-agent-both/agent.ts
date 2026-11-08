import {
  DEFAULT_ROUTE,
  LlmAgent,
  Workflow,
  createEvent,
  node,
  type NodeContext,
} from "@google/adk";
import { TypeSafeClient, noul } from "@typesafe-ai/sdk";

// "My wand keeps backfiring. Should I get it fixed or just buy a new one?"
//
// That message is a repair question AND a product question. A single-label
// router picks one and the other half goes unanswered. This version answers
// both: Jev scores each desk independently, and when both apply the technician
// diagnoses first, the wand specialist answers with that diagnosis in hand,
// and the front desk merges the two into one reply.
//
// Why in sequence and not in parallel: the halves depend on each other.
// Whether to buy a new wand depends on whether the old one can be saved, so
// the specialist should not recommend anything before the technician speaks.

// --- Specialists ---
// Factories, because the "both" path uses its own instances with a narrower
// brief and an `outputKey`, while the single-desk path keeps the originals.

function wandSpecialist(name: string, scope = "", outputKey?: string) {
  return new LlmAgent({
    name,
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

Be concise and stay in character.${scope}`,
    outputKey,
  });
}

function magicalTechnician(name: string, scope = "", outputKey?: string) {
  return new LlmAgent({
    name,
    model: "gemini-3.8-flash",
    description:
      "Diagnoses and repairs malfunctioning wands: wrong spells firing, damage, contamination, unresponsive cores.",
    instruction: `You are a magical technician at Ollivanders. Diagnose and
recommend a fix for malfunctioning wands — wrong spells firing, physical damage,
contamination, unresponsive cores, backfiring charms.

Ask one clarifying question if the symptom is vague, then give a short
diagnosis and a recommended next step. Be concise and stay in character.${scope}`,
    outputKey,
  });
}

// Single-desk instances: the whole message is theirs.
const productDesk = wandSpecialist("WandSpecialist");
const repairDesk = magicalTechnician("MagicalTechnician");

// "Both" instances. `outputKey` saves each reply into session state, and a
// `{key}` placeholder in a later instruction reads it back. That is how the
// diagnosis reaches the specialist and both answers reach the front desk.

const repairFirst = magicalTechnician(
  "repair",
  `\n\nThe message may also ask about buying a wand. A wand specialist will
handle that after you. Answer only the fault: what is likely wrong, whether it
is repairable, and roughly what the repair involves. Do not ask a question.`,
  "diagnosis",
);

const productNext = wandSpecialist(
  "product",
  `\n\nThe customer asked: {question}

A technician has already looked at the fault:
{diagnosis}

Answer only the buying question, using the diagnosis. If the wand is worth
repairing, say so and keep any recommendation short. If it is not, recommend
a replacement from the catalogue and say why it suits this customer.`,
  "recommendation",
);

// --- Router ---
// A `choice` question cannot say "both": its probabilities sum to 1, so a
// 50/50 split looks the same whether the message covers both desks or Jev is
// unsure. Two `noul` questions are scored independently, so a message can be
// 0.9 product AND 0.9 repair.

let client: TypeSafeClient | undefined;
const jev = () => (client ??= new TypeSafeClient()); // reads TYPESAFE_API_KEY

const YES = 0.5;

const userText = (ctx: NodeContext) =>
  ctx.invocationContext.userContent?.parts?.map((p) => p.text ?? "").join("") ?? "";

const router = node(
  async (ctx: NodeContext) => {
    const message = userText(ctx);
    const { answers } = await jev().systemOne({
      state: message,
      questions: {
        product: noul(
          "Does the customer want help choosing, buying or replacing a wand?",
          { true: "They ask what to buy, compare wands, or consider a new or replacement wand." },
        ),
        repair: noul(
          "Does the customer describe a wand that misbehaves or is damaged?",
          { true: "Wrong spells, sparks, backfiring, cracks, contamination or an unresponsive core." },
        ),
      },
    });

    const product = answers.product.noul >= YES;
    const repair = answers.repair.noul >= YES;
    const decided =
      product && repair ? "BOTH" : product ? "PRODUCT" : repair ? "REPAIR" : "OTHER";

    console.log(
      `[jev] product ${answers.product.noul.toFixed(2)}  repair ${answers.repair.noul.toFixed(2)}  -> ${decided}`,
    );

    // Only the BOTH chain needs `question` in state: there the specialist's
    // input is the technician's diagnosis, so it reads the original message
    // from state instead. Single-desk routes get the message as input.
    if (decided !== "BOTH") return createEvent({ route: decided, output: message });
    return createEvent({
      route: decided,
      output: message,
      actions: { stateDelta: { question: message } },
    });
  },
  { name: "jev_router" },
);

// --- Merge ---
// The only reply written for the customer. It reads both answers from state.

const frontDesk = new LlmAgent({
  name: "FrontDesk",
  model: "gemini-3.8-flash",
  description: "Merges the technician's and the wand specialist's answers into one reply.",
  instruction: `You are the Ollivanders front desk. The customer asked:
{question}

Your technician said:
{diagnosis}

Your wand specialist said:
{recommendation}

Write one short reply in character that answers both parts of the question:
first what is wrong and whether it can be fixed, then whether to repair or
replace. Name a replacement wand only if your specialist recommended one.
Use only what your colleagues said. Do not add new facts.`,
});

const redirect = node(
  () =>
    "I only handle wand questions — could you rephrase that as something about choosing or repairing a wand?",
  { name: "redirect" },
);

// --- The graph ---
// BOTH starts a chain instead of a single specialist: repair, then product,
// then the merge. The single-desk routes are unchanged.

export const rootAgent = new Workflow({
  name: "OllivandersFrontDeskBoth",
  edges: [
    ["START", router],
    [
      router,
      {
        PRODUCT: productDesk,
        REPAIR: repairDesk,
        BOTH: repairFirst,
        [DEFAULT_ROUTE]: redirect,
      },
    ],
    [repairFirst, productNext, frontDesk],
  ],
});
