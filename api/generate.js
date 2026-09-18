const MODEL = "gpt-5.6-luna";
const MAX_GOALS = 10;
const MAX_GOAL_LENGTH = 180;
const MAX_CURRENT_LENGTH = 100;
const ALLOWED_XP = [5, 10, 20, 35, 50, 100, 150];

const SYSTEM = `
You are the progression engine for Achievement Hitlist. Turn a person's goal into a motivating sequence of concrete achievements.

CORE RULES
- Create exactly one Hitlist for each input goal, preserving input order.
- Create 5-7 milestones per Hitlist.
- The milestones must form a realistic progression from the user's current level toward the requested goal.
- Never replace the user's goal with a different goal.
- The final milestone is the FINAL BOSS and must faithfully represent the requested outcome.
- Do not include the current level itself as an achievement when the user has already achieved it.
- Prefer meaningful human milestones over equal mathematical divisions.
- Every milestone must have an observable completion criterion.

GOAL TYPES
Classify each goal as one of:
performance_time, numeric_higher, numeric_lower, financial, frequency, completion, skill, habit, career, travel, learning, or other.

PRECISION AND DIRECTION
- Preserve meaningful units, decimals, dates, distances, weights, currencies, counts, and time precision.
- For performance-time goals, lower times are better. Never interpret 3:45 as the number 3.45.
- Use conventional time notation such as 3:45, 3:30, 1:29:59, 6:59, or sub-3:00 as appropriate.
- For numeric goals, determine whether progress should increase or decrease before constructing milestones.
- Never create a milestone that moves backward relative to the intended direction.
- If a target uses "under", "less than", "sub", "below", "over", "more than", or similar language, preserve that boundary correctly.

QUALITATIVE GOALS
- Do not invent fake percentages for qualitative skills.
- Build observable demonstrations of increasing ability.
- Example domains include language learning, instruments, cooking, confidence, professional skills, and creative work.
- Make milestones specific enough that the user can confidently decide whether they completed them.

MILESTONE QUALITY
- Titles should be short, motivating, and specific.
- Descriptions should clearly state what counts as completion.
- Avoid filler milestones such as "keep practicing" or "make progress".
- Use XP from 5, 10, 20, 35, 50, 100, 150 and generally increase rewards with difficulty.
`.trim();

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    hitlists: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          goalType: {
            type: "string",
            enum: [
              "performance_time", "numeric_higher", "numeric_lower", "financial",
              "frequency", "completion", "skill", "habit", "career", "travel",
              "learning", "other"
            ]
          },
          direction: { type: "string", enum: ["higher", "lower", "progressive", "completion"] },
          target: { type: "string" },
          milestones: {
            type: "array",
            minItems: 5,
            maxItems: 7,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                xp: { type: "integer", enum: ALLOWED_XP }
              },
              required: ["title", "description", "xp"]
            }
          }
        },
        required: ["title", "goalType", "direction", "target", "milestones"]
      }
    }
  },
  required: ["hitlists"]
};

function cleanGoals(body) {
  if (!Array.isArray(body?.goals)) return [];
  return body.goals.slice(0, MAX_GOALS).map(item => ({
    goal: typeof item?.goal === "string" ? item.goal.trim().slice(0, MAX_GOAL_LENGTH) : "",
    current: typeof item?.current === "string" ? item.current.trim().slice(0, MAX_CURRENT_LENGTH) : ""
  })).filter(item => item.goal);
}

function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text) return response.output_text;
  return (response?.output || [])
    .flatMap(item => item.content || [])
    .find(content => content.type === "output_text")?.text;
}

function validateHitlists(output, goals) {
  if (!Array.isArray(output?.hitlists) || output.hitlists.length !== goals.length) {
    throw new Error("Unexpected Hitlist count");
  }
  output.hitlists.forEach((hitlist, index) => {
    if (!hitlist.title?.trim() || !hitlist.target?.trim()) throw new Error("Missing Hitlist metadata");
    if (!Array.isArray(hitlist.milestones) || hitlist.milestones.length < 5 || hitlist.milestones.length > 7) {
      throw new Error("Invalid milestone count");
    }
    hitlist.milestones.forEach(milestone => {
      if (!milestone.title?.trim() || !milestone.description?.trim() || !ALLOWED_XP.includes(milestone.xp)) {
        throw new Error("Invalid milestone");
      }
    });
    if (!goals[index]?.goal) throw new Error("Goal alignment error");
  });
  return output;
}

async function generate(goals, correction = "") {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.OPENAI_API_KEY
    },
    body: JSON.stringify({
      model: MODEL,
      store: false,
      reasoning: { effort: "medium" },
      instructions: SYSTEM,
      input:
        "Create one Achievement Hitlist for every goal below, in the exact same order.\n" +
        JSON.stringify(goals) +
        (correction ? "\n\nPrevious generation failed validation. Correct it. Reason: " + correction : ""),
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "achievement_hitlists",
          strict: true,
          schema
        }
      }
    })
  });

  const json = await response.json();
  if (!response.ok) {
    console.error("OpenAI API error", response.status, json?.error?.code || "unknown");
    throw new Error("AI request failed");
  }

  const text = extractOutputText(json);
  if (!text) throw new Error("No AI output");
  return JSON.parse(text);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const goals = cleanGoals(req.body);
  if (!goals.length) return res.status(400).json({ error: "Add at least one goal." });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "AI connection is not configured." });

  try {
    let output;
    try {
      output = validateHitlists(await generate(goals), goals);
    } catch (firstError) {
      output = validateHitlists(await generate(goals, firstError.message), goals);
    }
    return res.status(200).json(output);
  } catch (error) {
    console.error("Hitlist generation failed", error?.message || error);
    return res.status(500).json({ error: "Could not build your Hitlist. Please try again." });
  }
}
