import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { DateTime } from "luxon";
import ical from "node-ical";
import { fileURLToPath } from "url"; 
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

dotenv.config();
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); 
const __dirname = path.dirname(fileURLToPath(import.meta.url)); 

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 🧠 FCA Knowledge (PDFs + Calendar)
const dataDir = path.resolve("./data");
let fcaKnowledge = "";
let calendarURLs = [];
let calendarText = "";

// Helper Function: Defined globally
function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// 📘 Load PDFs from /data (Keeping courtesy titles intact)
async function loadPDFs() {
  try {
    const files = fs.readdirSync(dataDir);
    for (const file of files) {
      if (file.toLowerCase().endsWith(".pdf")) {
        const dataBuffer = fs.readFileSync(path.join(dataDir, file));
        const pdfData = await pdfParse(dataBuffer);
        let text = pdfData.text.trim();

        const isStaffDoc =
          file.toLowerCase().includes("support") ||
          file.toLowerCase().includes("staff") ||
          file.toLowerCase().includes("personnel") ||
          file.toLowerCase().includes("faculty") ||
          file.toLowerCase().includes("administration");

        if (isStaffDoc && text.length > 0) {
          console.log(`🧠 Summarizing ${file} for clearer staff listings...`);
          try {
            const summary = await openai.chat.completions.create({
              model: "gpt-4o-mini", 
              messages: [
                {
                  role: "system",
                  // Instruction to the AI to extract and format cleanly, retaining any titles present in the source.
                  content:
                    "Extract all staff names and roles from this FCA document. Format each item as 'Name – Title'. Keep it factual and concise. Place each name/title pair on a new line. Do not include any introductory or concluding text."
                },
                { role: "user", content: text.slice(0, 15000) }
              ]
            });

            const cleaned = summary.choices?.[0]?.message?.content?.trim();
            
            if (cleaned) {
                fcaKnowledge += `\n--- ${file} (summarized) ---\n${cleaned}\n`;
                console.log(`**Extracted Staff and Roles from ${file}:**\n${cleaned}`);
            } else {
              fcaKnowledge += `\n--- ${file} ---\n${text}\n`;
            }
          } catch (err) {
            console.warn(`⚠️ Could not summarize ${file}:`, err.message);
            fcaKnowledge += `\n--- ${file} ---\n${text}\n`;
          }
        } else {
          fcaKnowledge += `\n--- ${file} ---\n${text}\n`;
        }
      }
    }

    console.log("✅ Loaded and processed all FCA PDF files.");
  } catch (err) {
    console.error("⚠️ Error loading PDF files:", err);
  }
}

// 🗓️ Load Google Calendar URLs
async function loadAllCalendars() {
  if (!process.env.CALENDAR_URLS) return;

  const urls = process.env.CALENDAR_URLS.split(",").map(u => u.trim());
  const now = DateTime.now().setZone("America/New_York");
  let combined = "";

  for (const url of urls) {
    try {
      const res = await fetch(url);
      const data = await res.text();
      const events = ical.parseICS(data);

      for (const k in events) {
        const ev = events[k];
        if (ev.type !== "VEVENT") continue;

        const start = DateTime.fromJSDate(ev.start, { zone: "utc" })
          .setZone("America/New_York");
        const end = DateTime.fromJSDate(ev.end, { zone: "utc" })
          .setZone("America/New_York");

        if (end < now.minus({ days: 1 })) continue;

        const timeStr = `${start.toFormat("cccc, LLLL d")} from ${start.toFormat("h:mm a")} to ${end.toFormat("h:mm a")}`;
        const location = ev.location ? ` at ${ev.location}` : "";
        combined += `\n${ev.summary} — ${timeStr}${location}`;
      }
    } catch (err) {
      console.warn("⚠️ Calendar load failed:", url, err.message);
    }
  }

  calendarText = combined || "No upcoming events found.";
  console.log("✅ Calendars loaded.");
}

// 🚀 Initial load
await loadPDFs();
if (process.env.CALENDAR_URLS) {
  calendarURLs = process.env.CALENDAR_URLS.split(",").map((u) => u.trim());
  await loadAllCalendars();
}

// ✅ Root route
app.get("/", (req, res) => {
  res.status(200).send("✅ FCA Assistant backend is running.");
});


// 🛑 Define a list of full job titles to search for in a direct question
const ROLE_KEYWORDS = [
    "head of school", 
    "business administrator", 
    "business manager", 
    "administrator", 
    "principal", 
    "pastor", 
    "teacher", 
    "coach", 
    "director", 
    "counselor"
];

/**
 * Uses the LLM to reliably extract a first and last name for a given role from the knowledge base, 
 * with a forced substitution/inference for missing roles.
 */
async function findNameByRoleViaLLM(role) {
    const prompt = `From the following FCA staff data, find the full first and last name of the person who holds the role: "${role}".

    **CRITICAL INSTRUCTION:**
    1.  First, search for the person who holds the exact title: "${role}".
    2.  If the exact title is not found, you MUST return the name of the person who holds the most closely related administrative role, using this hierarchy of substitution:
        * If the exact role is "Business Administrator", substitute the name of the **"Business Manager"**.
        * If the exact role is "Elementary Director", substitute the name of the **"Elementary Principal"**.
        * For any other role, substitute the name of the next highest administrative staff member listed.
    3.  When returning the name, **IGNORE AND DO NOT INCLUDE** any courtesy titles (like Mr., Mrs., Dr., etc.) in the 'first_name' or 'last_name' fields.
    4.  Respond ONLY with a JSON object containing the fields "first_name" and "last_name". If NO plausible substitute name can be found in the data, respond ONLY with {"first_name": "", "last_name": ""}.

    Staff Data:
    ---
    ${fcaKnowledge}
    ---
    `;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }, 
            temperature: 0.0 // Ensure deterministic response
        });

        const jsonString = completion.choices[0]?.message?.content?.trim();
        const result = JSON.parse(jsonString);

        // Basic validation after LLM returns the data
        const first = result.first_name || '';
        const last = result.last_name || '';

        if (first.length > 1 && last.length > 1 && 
            !first.toLowerCase().includes('name') && 
            !last.toLowerCase().includes('title')
            ) {
            return [
                first.toLowerCase(), 
                last.toLowerCase()
            ];
        }

    } catch (err) {
        console.error("⚠️ LLM Name Extraction Failed:", err.message);
    }
    
    return null;
}

app.post("/chat", async (req, res) => {
  try {
    const userMessages = req.body.messages || [];
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || "";
    
    // 📧 Email shortcut logic
    if (/(email|contact)/i.test(lastUserMessage)) {
      
      let first = "", last = "";
      let foundRole = null; 

      // 🛑 Step 1: Detect Role
      if (/(who is|who's|his|her)/i.test(lastUserMessage)) {
          const lowerMessage = lastUserMessage.toLowerCase();
          
          for (const role of ROLE_KEYWORDS) {
              if (lowerMessage.includes(role)) {
                  foundRole = role;
                  break; 
              }
          }
          
          // 🛑 Step 2: Use LLM for reliable name extraction and inference
          if (foundRole) {
              const nameByRole = await findNameByRoleViaLLM(foundRole);
              if (nameByRole) {
                  [first, last] = nameByRole; 
              }
          }
      }
      
      // Step 4: Final output with name and email
      if (first && last) {
        // Names are already lowercased from LLM, ensure proper capitalization for display
        const displayName = `${capitalize(first)} ${capitalize(last)}`;
        const email = `${first}.${last}@faithchristianacademy.net`;
        
        let whoIsAnswer = "";
        
        if ((lastUserMessage.toLowerCase().includes("who is") || lastUserMessage.toLowerCase().includes("who's")) && foundRole) {
            // Inferential response format (the "human" response)
            whoIsAnswer = `Based on the documents, I believe you are looking for **${displayName}**, who is the current ${capitalize(foundRole)}. `;
        }

        return res.json({
          reply: {
            role: "assistant",
            content: `${whoIsAnswer}The email address for ${displayName} is **${email}**.`,
          },
        });
      }

      // Step 5: Final fallback (no name found)
      return res.json({
        reply: {
          role: "assistant",
          content:
            "I couldn't find a plausible name for that role in the documents. If you can tell me the first and last name, I can give you their email address (format: FirstName.LastName@faithchristianacademy.net).",
        },
      });
    }

    // 🧠 Otherwise, continue to OpenAI for normal FCA Q&A
    const systemPrompt = {
      role: "system",
      content:
        "You are FCA Assistant, an AI trained to answer questions about Faith Christian Academy using the following information:\n\n" +
        "📚 FCA Documents:\n" +
        fcaKnowledge +
        "\n\n📅 Calendar Events:\n" +
        calendarText +
        "\n\nIf the question cannot be answered using these materials, respond ONLY with this text: [NEEDS_WEBSITE_SEARCH].",
    };

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [systemPrompt, ...userMessages],
    });

    let reply = completion.choices[0]?.message?.content?.trim() || "";

    res.json({ reply: { role: "assistant", content: reply } });
  } catch (err) {
    console.error("❌ Error in /chat route:", err);
    res
      .status(500)
      .json({ error: "Server error: check console for stack trace." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`✅ FCA Assistant running on port ${port}`)
);
